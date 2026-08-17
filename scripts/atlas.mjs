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

const INDEXABLE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.sql', '.prisma'])
// Import edges are a JavaScript and TypeScript idea. Python and SQL files are indexed
// for their symbols and stay in the graph as nodes without edges.
const IMPORTABLE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs'])
const SKIP = /(^|\/)(node_modules|dist|build|\.next|\.claude|coverage|test|tests|__tests__)(\/|$)|\.(test|spec)\.[^/]+$/

// Modes that read the index instead of building it. Each takes a value except
// --impact, which reads the working tree.
const QUERIES = new Set(['--find', '--deps', '--rdeps', '--history', '--impact', '--candidates'])

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
      const needsValue = flag !== '--impact' && flag !== '--candidates'
      if (needsValue) {
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

  let graph
  try {
    graph = loadGraph(join(repo, '.claude', 'atlas'))
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }

  if (query === '--find') console.log(formatSymbols(findSymbol(graph, value)))
  else if (query === '--deps') console.log(formatWalk(value, dependencies(graph, value, { depth }), 'dependencies'))
  else if (query === '--rdeps') console.log(formatWalk(value, dependents(graph, value, { depth }), 'dependents'))
  else if (query === '--impact') console.log(formatImpact(repo, graph))
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
