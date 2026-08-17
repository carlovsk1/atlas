#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, extname, basename, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listFiles, dirtyFiles, headSha } from './lib/git.mjs'
import { extractFile } from './lib/extract.mjs'
import { extractImports, buildResolver } from './lib/imports.mjs'
import { bucketOf, areaOf, BUCKETS } from './lib/classify.mjs'
import { readState, writeState, planWork, STATE_VERSION } from './lib/state.mjs'
import { renderInventory, renderIndex, buildGraph } from './lib/render.mjs'
import { buildViewerData, renderViewer } from './lib/viewer.mjs'
import { loadGraph, findSymbol, dependencies, dependents, formatSymbols, formatWalk } from './lib/query.mjs'
import { fileHistory, decisionCandidates } from './lib/history.mjs'
import { record, readLedger, duplicateNames } from './lib/ledger.mjs'

const INDEXABLE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.sql', '.prisma'])
// Import edges are a JavaScript and TypeScript idea. Python and SQL files are indexed
// for their symbols and stay in the graph as nodes without edges.
const IMPORTABLE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs'])
const SKIP = /(^|\/)(node_modules|dist|build|\.next|\.claude|coverage|test|tests|__tests__)(\/|$)|\.(test|spec)\.[^/]+$/

// Modes that read the index instead of building it. Each takes a value except
// --impact, --candidates, and --report, which take none.
const QUERIES = new Set(['--find', '--deps', '--rdeps', '--history', '--impact', '--candidates', '--report'])
const VALUELESS = new Set(['--impact', '--candidates', '--report'])

function parseArgs(argv) {
  const args = { repo: process.cwd(), update: false, graph: false, query: null, value: '', depth: 1 }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--repo') {
      args.repo = argv[++i]
      if (args.repo === undefined) {
        console.error('atlas: --repo requires a path')
        process.exit(1)
      }
    } else if (flag === '--update') args.update = true
    else if (flag === '--graph') args.graph = true
    else if (flag === '--depth') args.depth = Math.max(1, Number(argv[++i]) || 1)
    else if (QUERIES.has(flag)) {
      args.query = flag
      if (!VALUELESS.has(flag)) {
        args.value = argv[++i] ?? ''
        if (!args.value) {
          console.error(`atlas: ${flag} requires a value`)
          process.exit(1)
        }
      }
    }
  }
  return args
}

function loadConfig(repo) {
  try {
    return JSON.parse(readFileSync(join(repo, 'atlas.config.json'), 'utf8'))
  } catch {
    return {}
  }
}

export function indexable(path) {
  return INDEXABLE.has(extname(path)) && !SKIP.test(path)
}

function listSlugs(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .sort()
  } catch {
    return []
  }
}

/** Changed files first by how many other files import them: the risky ones lead. */
function formatImpact(repo, graph) {
  const changed = [...dirtyFiles(repo)].filter(indexable).sort()
  if (changed.length === 0) return 'atlas: no indexable file changed in the working tree'

  const rows = changed.map((path) => {
    const direct = dependents(graph, path, { depth: 1 })
    return { path, count: direct.unknown ? -1 : direct.length }
  })
  rows.sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1))

  const lines = [`${rows.length} changed file${rows.length === 1 ? '' : 's'}, most depended on first`]
  for (const { path, count } of rows) {
    lines.push(count < 0 ? `${path}  not indexed yet` : `${path}  ${count} importer${count === 1 ? '' : 's'}`)
  }
  return lines.join('\n')
}

// What an assist is, in the order a reader cares about. `--impact` counts as a blast
// radius like `--rdeps` does, because it is the same answer asked for the whole tree.
const ASSISTS = [
  ['gate', 'duplicates prevented', 'gate denied a Write'],
  ['find', 'context delivered', 'a name asked for already existed'],
  ['rdeps', 'blast radius shown', 'dependents before an edit'],
]
const REINVENTED = 5
const MIN_REINVENTED = 2
const DAY = 86_400_000

/**
 * What Atlas has actually done in this repository, from the ledger the hooks write, plus
 * the one number that does not come from Atlas at all: how much duplication the
 * repository carries right now. Every line here is an event that happened. Nothing here
 * claims what would have happened without the plugin, because nothing can.
 */
function formatReport(events, graph) {
  const duplication = `repo duplication  ${duplicateNames(graph)} names exported from 2+ files`
  if (events.length === 0) return ['atlas: no assists recorded yet', '', duplication].join('\n')

  const stamps = events.map((e) => Date.parse(e.ts)).filter(Number.isFinite)
  const span = stamps.length ? Math.max(1, Math.ceil((Math.max(...stamps) - Math.min(...stamps)) / DAY)) : 1
  const sessions = new Set(events.map((e) => e.session).filter(Boolean)).size

  const header = [`${span} ${span === 1 ? 'day' : 'days'}`]
  if (sessions) header.push(`${sessions} ${sessions === 1 ? 'session' : 'sessions'}`)
  const lines = [header.join(' · '), '']

  const counts = new Map()
  for (const event of events) {
    const kind = event.kind === 'impact' ? 'rdeps' : event.kind
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  for (const [kind, label, hint] of ASSISTS) {
    lines.push(`${label.padEnd(22)}${String(counts.get(kind) ?? 0).padStart(3)}   ${hint}`)
  }

  // A name asked for twice is a name someone was about to write twice.
  const byName = new Map()
  for (const event of events) {
    if (event.kind !== 'gate' && event.kind !== 'find') continue
    const seen = byName.get(event.name)
    if (seen) seen.count++
    else byName.set(event.name, { count: 1, at: event.at })
  }
  const repeated = [...byName]
    .filter(([, v]) => v.count >= MIN_REINVENTED)
    .sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1))
    .slice(0, REINVENTED)

  if (repeated.length) {
    lines.push('', 'most re-invented')
    for (const [name, { count, at }] of repeated) {
      lines.push(`  ${name.padEnd(18)}${count}x   ${at ?? ''}`.trimEnd())
    }
  }

  lines.push('', duplication)
  return lines.join('\n')
}

function formatCommits(commits, indent = '') {
  return commits.map((c) => `${indent}${c.sha.slice(0, 8)}  ${c.date.slice(0, 10)}  ${c.subject}`)
}

/** Reads the index rather than building it. Every mode prints and returns. */
function runQuery({ repo, query, value, depth }) {
  if (query === '--history') {
    const commits = fileHistory(repo, value)
    console.log(commits.length ? formatCommits(commits).join('\n') : `atlas: git knows no history for \`${value}\``)
    return
  }

  if (query === '--candidates') {
    const candidates = decisionCandidates(repo)
    if (candidates.length === 0) {
      console.log('atlas: no file in this history carries enough corrective commits to suggest a decision')
      return
    }
    const lines = [`${candidates.length} files whose history suggests an undocumented rule`]
    for (const { path, signal, commits } of candidates) {
      lines.push(`\n${path}  [${signal}]`, ...formatCommits(commits, '   '))
    }
    console.log(lines.join('\n'))
    return
  }

  const atlasDir = join(repo, '.claude', 'atlas')
  let graph
  try {
    graph = loadGraph(atlasDir)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }

  // An answer only counts as an assist when it carried something: a query that found
  // nothing cost a call and taught the caller that the name is free, which the ledger
  // has no reason to celebrate.
  if (query === '--find') {
    const matches = findSymbol(graph, value)
    console.log(formatSymbols(matches))
    if (matches.total > 0) {
      record(atlasDir, { kind: 'find', name: value, at: `${matches[0].path}:${matches[0].line}`, matches: matches.total })
    }
  } else if (query === '--deps') {
    console.log(formatWalk(value, dependencies(graph, value, { depth }), 'dependencies'))
  } else if (query === '--rdeps') {
    const who = dependents(graph, value, { depth })
    console.log(formatWalk(value, who, 'dependents'))
    if (!who.unknown && who.length > 0) record(atlasDir, { kind: 'rdeps', path: value, count: who.length })
  } else if (query === '--impact') {
    console.log(formatImpact(repo, graph))
    record(atlasDir, { kind: 'impact' })
  } else if (query === '--report') {
    console.log(formatReport(readLedger(atlasDir), graph))
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.query) return runQuery(args)

  const { repo, update, graph } = args
  const config = loadConfig(repo)
  const atlasDir = join(repo, '.claude', 'atlas')

  const files = listFiles(repo)
  const dirty = dirtyFiles(repo)
  const prev = update ? readState(atlasDir) : null
  const plan = planWork(prev, files, dirty, indexable)

  const nodesByFile = {}
  const importsByFile = {}
  if (prev && prev.version === STATE_VERSION) {
    for (const path of plan.unchanged) {
      if (prev.nodesByFile[path]) nodesByFile[path] = prev.nodesByFile[path]
      if (prev.importsByFile?.[path]) importsByFile[path] = prev.importsByFile[path]
    }
  }

  for (const path of plan.toExtract) {
    const content = readFileSync(join(repo, path), 'utf8')
    nodesByFile[path] = extractFile(path, content)
    if (IMPORTABLE.has(extname(path))) importsByFile[path] = extractImports(content)
  }

  const indexed = Object.keys(nodesByFile).sort()
  const nodes = indexed.flatMap((path) => nodesByFile[path])

  // Specifiers are stored raw and resolved on every run: what a specifier points at
  // depends on the whole file set, which changes even when the importing file does not.
  const resolveImport = buildResolver(repo, new Set(indexed))
  const seenEdges = new Set()
  const imports = []
  for (const path of indexed) {
    for (const spec of importsByFile[path] ?? []) {
      const target = resolveImport(spec, path)
      if (!target || seenEdges.has(`${path} ${target}`)) continue
      seenEdges.add(`${path} ${target}`)
      imports.push({ from: path, to: target })
    }
  }

  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, []]))
  for (const node of nodes) buckets[bucketOf(node)].push(node)

  mkdirSync(join(atlasDir, 'inventory'), { recursive: true })
  mkdirSync(join(atlasDir, 'patterns'), { recursive: true })
  mkdirSync(join(atlasDir, 'decisions'), { recursive: true })

  for (const bucket of BUCKETS) {
    writeFileSync(join(atlasDir, 'inventory', `${bucket}.md`), renderInventory(bucket, buckets[bucket], config))
  }

  const commit = headSha(repo)
  const indexedAt = new Date().toISOString()
  const areas = [...new Set(nodes.map((n) => areaOf(n.path, config)))]

  writeFileSync(
    join(atlasDir, 'INDEX.md'),
    renderIndex({
      commit: commit ? commit.slice(0, 7) : 'uncommitted',
      date: indexedAt.slice(0, 10),
      counts: Object.fromEntries(BUCKETS.map((b) => [b, buckets[b].length])),
      areas,
      patterns: listSlugs(join(atlasDir, 'patterns')),
      decisions: listSlugs(join(atlasDir, 'decisions')),
    })
  )

  writeFileSync(
    join(atlasDir, 'graph.json'),
    JSON.stringify(buildGraph(nodes, config, indexed, imports), null, 2) + '\n'
  )

  if (graph) {
    writeFileSync(
      join(atlasDir, 'graph.html'),
      renderViewer(
        buildViewerData({
          repo: basename(resolvePath(repo)),
          root: resolvePath(repo),
          commit: commit ? commit.slice(0, 7) : 'uncommitted',
          date: indexedAt.slice(0, 10),
          files: indexed,
          nodes,
          imports,
          config,
        })
      )
    )
  }

  writeState(atlasDir, {
    version: STATE_VERSION,
    indexedAt,
    commit,
    files: Object.fromEntries([...files].filter(([p]) => indexable(p))),
    nodesByFile,
    importsByFile,
  })

  console.log(
    `atlas: extracted ${plan.toExtract.length}, skipped ${plan.unchanged.length}, removed ${plan.removed.length}, ${nodes.length} entries and ${imports.length} import edges total`
  )
  if (graph) console.log(`atlas: wrote ${join(atlasDir, 'graph.html')}`)
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) main()
