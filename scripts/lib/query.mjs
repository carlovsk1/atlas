import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const GRAPH_FILE = 'graph.json'

// A query answer is read into a context window, not scrolled in a terminal: past
// twenty lines the caller should narrow the question instead of reading more.
const LINE_CAP = 20

function push(map, key, value) {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** Import edges point at `file:<path>` node ids; queries speak in plain paths. */
function pathOf(id) {
  return id.startsWith('file:') ? id.slice(5) : id
}

function byPathThenLine(a, b) {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1
  return (a.line ?? 0) - (b.line ?? 0)
}

/** Carries the pre-truncation count so a formatter can report what it dropped. */
function withTotal(entries, total) {
  return Object.assign(entries, { total })
}

/**
 * Loads graph.json into lookup maps. Throws a clear Error if the file is missing,
 * because the caller's next move is `/atlas-init`, not a stack trace.
 */
export function loadGraph(atlasDir) {
  const file = join(atlasDir, GRAPH_FILE)

  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    const why = err.code === 'ENOENT' ? 'file not found' : err.message
    throw new Error(`atlas: cannot read ${file} (${why}). Run /atlas-init to build the index.`)
  }

  if (!Array.isArray(parsed?.nodes) || !Array.isArray(parsed?.edges)) {
    throw new Error(`atlas: ${file} is not an Atlas graph. Run /atlas-init to rebuild it.`)
  }

  const symbols = []
  const files = new Map()
  for (const node of parsed.nodes) {
    if (node.kind === 'file') files.set(node.path, node)
    else if (node.kind !== 'area') symbols.push(node)
  }

  const imports = new Map()
  const importedBy = new Map()
  for (const edge of parsed.edges) {
    if (edge.kind !== 'imports') continue
    const from = pathOf(edge.from)
    const to = pathOf(edge.to)
    push(imports, from, to)
    push(importedBy, to, from)
  }

  // Adjacency order decides walk order, so sort once at load instead of per query.
  for (const list of imports.values()) list.sort()
  for (const list of importedBy.values()) list.sort()

  return { symbols, files, imports, importedBy }
}

/**
 * Symbols whose name matches `needle`, exact matches first, then case-insensitive
 * substring. The returned array carries `total`, the match count before `limit`
 * cut it, so nothing is truncated silently.
 */
export function findSymbol(graph, needle, { limit = 20 } = {}) {
  if (!needle) return withTotal([], 0)

  // ponytail: linear scan over every symbol, one pass per query. At ~6.5k symbols
  // that is sub-millisecond; build a lowercased name index if queries ever batch.
  const lower = needle.toLowerCase()
  const exact = []
  const partial = []
  for (const node of graph.symbols) {
    if (node.name === needle) exact.push(node)
    else if (node.name.toLowerCase().includes(lower)) partial.push(node)
  }

  exact.sort(byPathThenLine)
  partial.sort(byPathThenLine)

  const ranked = [...exact, ...partial]
  const entries = ranked
    .slice(0, limit)
    .map(({ name, kind, path, line, area }) => ({ name, kind, path, line, area }))

  return withTotal(entries, ranked.length)
}

/**
 * Breadth-first walk over one direction of the import graph. Each path is emitted
 * once at its shortest depth, which is also what makes a cycle terminate.
 */
function walk(adjacency, start, depth) {
  const seen = new Set([start])
  const out = []
  let frontier = [start]

  for (let level = 1; level <= depth && frontier.length > 0; level++) {
    const next = []
    for (const from of frontier) {
      for (const to of adjacency.get(from) ?? []) {
        if (seen.has(to)) continue
        seen.add(to)
        out.push({ path: to, depth: level, via: from })
        next.push(to)
      }
    }
    frontier = next
  }

  return out
}

/**
 * Files that `path` imports, breadth-first. depth 1 is direct imports only. An
 * unknown path returns an empty array flagged `unknown`, so the caller can say
 * "not indexed" rather than "imports nothing".
 */
export function dependencies(graph, path, { depth = 1 } = {}) {
  if (!graph.files.has(path)) return Object.assign([], { unknown: true })
  return walk(graph.imports, path, depth)
}

/** Files that import `path`, breadth-first. This is the blast radius of changing it. */
export function dependents(graph, path, { depth = 1 } = {}) {
  if (!graph.files.has(path)) return Object.assign([], { unknown: true })
  return walk(graph.importedBy, path, depth)
}

/** One line per match: name, kind, location, area. */
export function formatSymbols(matches) {
  const total = matches.total ?? matches.length
  if (total === 0) return 'atlas: no symbol matched'

  const shown = matches.slice(0, LINE_CAP)
  const lines = [`${total} ${total === 1 ? 'match' : 'matches'}`]
  for (const m of shown) {
    const location = m.line ? `${m.path}:${m.line}` : m.path
    lines.push([m.name, m.kind, location, m.area].filter(Boolean).join('  '))
  }

  const omitted = total - shown.length
  if (omitted > 0) lines.push(`... ${omitted} more omitted, cap ${LINE_CAP}`)

  return lines.join('\n')
}

/** One line per reached file, with the hop it came through once depth exceeds 1. */
export function formatWalk(path, results, direction) {
  if (results.unknown) {
    return `atlas: \`${path}\` is not an indexed file. Use the repository-relative path, for example packages/web/src/lib/money.ts`
  }

  const total = results.length
  const verb = direction === 'dependencies' ? 'imports' : 'is imported by'
  const lines = [`${path} ${verb} ${total} ${total === 1 ? 'file' : 'files'}`]

  for (const r of results.slice(0, LINE_CAP)) {
    lines.push(r.depth === 1 ? `${r.path}  d1` : `${r.path}  d${r.depth} via ${r.via}`)
  }

  const omitted = total - Math.min(total, LINE_CAP)
  if (omitted > 0) lines.push(`... ${omitted} more omitted, cap ${LINE_CAP}`)

  return lines.join('\n')
}
