import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { collidable } from './rules.mjs'

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
 * Names declared in more than one file among these matches. Two files declaring the same
 * exported name is the fingerprint of a fork, one primitive copied instead of shared, and
 * it is invisible in a flat list once a few substring hits sit between the two lines.
 */
function forksIn(nodes) {
  const paths = new Map()
  for (const node of nodes) {
    if (!collidable(node)) continue
    const seen = paths.get(node.name)
    if (seen) seen.add(node.path)
    else paths.set(node.name, new Set([node.path]))
  }

  const out = []
  for (const [name, files] of paths) {
    if (files.size > 1) out.push({ name, paths: [...files].sort() })
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1))
}

/**
 * Symbols whose name matches `needle`: exact name first, then the aliases a re-export
 * publishes it under, then case-insensitive substring. The returned array carries
 * `total`, the match count before `limit` cut it, and `forks`, the names among those
 * matches that more than one file declares.
 *
 * Matching a re-export by its `source` is what makes one search find both names a symbol
 * answers to. Without it `--find PageScaffold` reports one hit and stays silent about the
 * `AdvisorPageScaffold` every advisor file actually imports.
 */
export function findSymbol(graph, needle, { limit = 20 } = {}) {
  if (!needle) return withTotal([], 0)

  // ponytail: linear scan over every symbol, one pass per query. At ~6.5k symbols
  // that is sub-millisecond; build a lowercased name index if queries ever batch.
  const lower = needle.toLowerCase()
  const exact = []
  const aliased = []
  const partial = []
  for (const node of graph.symbols) {
    if (node.name === needle) exact.push(node)
    else if (node.source === needle) aliased.push(node)
    else if (node.name.toLowerCase().includes(lower)) partial.push(node)
  }

  exact.sort(byPathThenLine)
  aliased.sort(byPathThenLine)
  partial.sort(byPathThenLine)

  const ranked = [...exact, ...aliased, ...partial]
  const entries = ranked
    .slice(0, limit)
    .map(({ name, kind, path, line, area, source, from }) => ({
      name,
      kind,
      path,
      line,
      area,
      ...(source ? { source, from } : {}),
    }))

  return Object.assign(withTotal(entries, ranked.length), { forks: forksIn(ranked) })
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

/**
 * Files under `under` that never reach `target` through imports. The inverse of
 * `dependents`, and the question an adoption audit actually asks: `--rdeps` names who
 * already uses the shared primitive, which is the half you were not worried about.
 *
 * Depth matters more here than anywhere else. A page rarely imports a shell directly:
 * it renders a view component that does, so at depth 1 every compliant page reads as a
 * violation. The caller's default is 3 hops for that reason.
 *
 * Route files sort first: when the scope is a route group, the pages are the answer and
 * the components under them are context.
 */
export function unreached(graph, target, { under = '', depth = 3 } = {}) {
  if (!graph.files.has(target)) return Object.assign([], { unknown: true })

  const reaching = new Set(walk(graph.importedBy, target, depth).map((r) => r.path))
  const routes = new Map()
  for (const node of graph.symbols) {
    if (node.kind === 'route' && !routes.has(node.path)) routes.set(node.path, node.name)
  }

  const scoped = [...graph.files.keys()].filter((p) => p !== target && p.includes(under))
  const out = scoped
    .filter((p) => !reaching.has(p))
    .map((p) => ({ path: p, route: routes.get(p) ?? null }))

  out.sort((a, b) => (a.route ? 0 : 1) - (b.route ? 0 : 1) || (a.path < b.path ? -1 : 1))
  return Object.assign(out, {
    scoped: scoped.length,
    reaching: reaching.size,
    routes: out.filter((r) => r.route).length,
  })
}

/** One line per match: name, kind, location, area. Forks are called out under the list. */
export function formatSymbols(matches) {
  const total = matches.total ?? matches.length
  if (total === 0) return 'atlas: no symbol matched'

  const shown = matches.slice(0, LINE_CAP)
  const lines = [`${total} ${total === 1 ? 'match' : 'matches'}`]
  for (const m of shown) {
    const location = m.line ? `${m.path}:${m.line}` : m.path
    const kind = m.source ? `${m.kind} of ${m.source}` : m.kind
    lines.push([m.name, kind, location, m.area].filter(Boolean).join('  '))
  }

  const omitted = total - shown.length
  if (omitted > 0) lines.push(`... ${omitted} more omitted, cap ${LINE_CAP}`)

  // Below the list, not merged into it: a fork is a conclusion about the result set, and
  // buried between substring hits it is exactly what a reader skims past.
  for (const fork of matches.forks ?? []) {
    lines.push('', `${fork.name} is declared in ${fork.paths.length} files, likely a fork:`)
    for (const path of fork.paths) lines.push(`  ${path}`)
  }

  return lines.join('\n')
}

/** One line per file that never reaches the target, routes first. */
export function formatUnreached(target, results, under, depth) {
  if (results.unknown) {
    return `atlas: \`${target}\` is not an indexed file. Use the repository-relative path, for example packages/web/src/lib/money.ts`
  }

  const hops = `${depth} hop${depth === 1 ? '' : 's'}`
  if (results.scoped === 0) return `atlas: no indexed file has a path containing \`${under}\``
  if (results.length === 0) {
    return `all ${results.scoped} files under \`${under}\` reach ${target} within ${hops}`
  }

  // The raw ratio counts every leaf component in the scope and reads as alarm. The route
  // count is the number someone acts on, so it goes in the same breath.
  const routes = results.routes ? `, ${results.routes} of them routes` : ''
  const lines = [
    `${results.length} of ${results.scoped} files under \`${under}\` never reach ${target} within ${hops}${routes}`,
  ]
  for (const r of results.slice(0, LINE_CAP)) {
    lines.push(r.route ? `${r.path}  route ${r.route}` : r.path)
  }

  const omitted = results.length - Math.min(results.length, LINE_CAP)
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
