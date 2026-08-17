#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { listFiles, dirtyFiles, headSha } from './lib/git.mjs'
import { extractFile } from './lib/extract.mjs'
import { bucketOf, areaOf, BUCKETS } from './lib/classify.mjs'
import { readState, writeState, planWork, STATE_VERSION } from './lib/state.mjs'
import { renderInventory, renderIndex, buildGraph } from './lib/render.mjs'

const INDEXABLE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.sql', '.prisma'])
const SKIP = /(^|\/)(node_modules|dist|build|\.next|\.claude|coverage|test|tests|__tests__)(\/|$)|\.(test|spec)\.[^/]+$/

function parseArgs(argv) {
  const args = { repo: process.cwd(), update: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') {
      args.repo = argv[++i]
      if (args.repo === undefined) {
        console.error('atlas: --repo requires a path')
        process.exit(1)
      }
    } else if (argv[i] === '--update') args.update = true
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

function main() {
  const { repo, update } = parseArgs(process.argv.slice(2))
  const config = loadConfig(repo)
  const atlasDir = join(repo, '.claude', 'atlas')

  const files = listFiles(repo)
  const dirty = dirtyFiles(repo)
  const prev = update ? readState(atlasDir) : null
  const plan = planWork(prev, files, dirty, indexable)

  const nodesByFile = {}
  if (prev && prev.version === STATE_VERSION) {
    for (const path of plan.unchanged) {
      if (prev.nodesByFile[path]) nodesByFile[path] = prev.nodesByFile[path]
    }
  }

  for (const path of plan.toExtract) {
    const content = readFileSync(join(repo, path), 'utf8')
    nodesByFile[path] = extractFile(path, content)
  }

  const nodes = Object.keys(nodesByFile).sort().flatMap((path) => nodesByFile[path])

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

  writeFileSync(join(atlasDir, 'graph.json'), JSON.stringify(buildGraph(nodes, config), null, 2) + '\n')

  writeState(atlasDir, {
    version: STATE_VERSION,
    indexedAt,
    commit,
    files: Object.fromEntries([...files].filter(([p]) => indexable(p))),
    nodesByFile,
  })

  console.log(
    `atlas: extracted ${plan.toExtract.length}, skipped ${plan.unchanged.length}, removed ${plan.removed.length}, ${nodes.length} entries total`
  )
}

if (import.meta.url === `file://${process.argv[1]}`) main()
