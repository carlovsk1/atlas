import { areaOf, BUCKETS } from './classify.mjs'

const TITLES = {
  components: 'Components',
  hooks: 'Hooks',
  routes: 'Routes',
  data: 'Data',
  utils: 'Utils',
}

function byPathThenLine(a, b) {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1
  if (a.line !== b.line) return a.line - b.line
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function escapeCell(text) {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/** Renders one inventory file, grouped by area, deterministically ordered. */
export function renderInventory(bucket, nodes, config = {}) {
  const lines = [`# ${TITLES[bucket] ?? bucket}`, '']

  if (nodes.length === 0) {
    lines.push('No entries found. Run `/atlas-update` after adding code here.', '')
    return lines.join('\n')
  }

  const groups = new Map()
  for (const node of nodes) {
    const area = areaOf(node.path, config)
    if (!groups.has(area)) groups.set(area, [])
    groups.get(area).push(node)
  }

  for (const area of [...groups.keys()].sort()) {
    lines.push(`## ${area}`, '')
    lines.push('| Symbol | Kind | Location | Purpose |')
    lines.push('|---|---|---|---|')
    for (const node of groups.get(area).sort(byPathThenLine)) {
      lines.push(`| \`${node.name}\` | ${node.kind} | \`${node.path}:${node.line}\` | ${escapeCell(node.purpose)} |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/** Renders the hub file. Empty buckets are omitted rather than linked to nothing. */
export function renderIndex({ commit, date, counts, areas, patterns, decisions }) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
  const lines = [
    '# Atlas Index',
    '',
    `Indexed at \`${commit}\` on ${date} · ${areas.length} areas · ${total} entries`,
    '',
    '> Discovery and decision only. Before using any symbol listed here, open the',
    '> file at the given location and read the real signature.',
    '',
    '## Inventory',
    '',
  ]

  for (const bucket of BUCKETS) {
    const count = counts[bucket] ?? 0
    if (count === 0) continue
    lines.push(`- [${TITLES[bucket]}](inventory/${bucket}.md) — ${count} entries`)
  }

  lines.push('', '## Areas', '')
  for (const area of [...areas].sort()) lines.push(`- \`${area}\``)

  lines.push('', '## Patterns', '')
  if (patterns.length === 0) lines.push('_None recorded yet._')
  for (const slug of [...patterns].sort()) lines.push(`- [${slug}](patterns/${slug}.md)`)

  lines.push('', '## Decisions', '')
  if (decisions.length === 0) lines.push('_None recorded yet._')
  for (const slug of [...decisions].sort()) lines.push(`- [${slug}](decisions/${slug}.md)`)

  lines.push('')
  return lines.join('\n')
}

/** Builds the nodes/edges byproduct. Not read by the agent; kept for later tooling. */
export function buildGraph(nodes, config = {}, files = [], imports = []) {
  const out = new Map()
  const edges = []

  for (const node of nodes) {
    const area = areaOf(node.path, config)
    const areaId = `area:${area}`
    if (!out.has(areaId)) out.set(areaId, { id: areaId, kind: 'area', name: area })
    out.set(node.id, {
      id: node.id,
      kind: node.kind,
      name: node.name,
      path: node.path,
      line: node.line,
      area,
    })
    edges.push({ from: areaId, to: node.id, kind: 'contains' })
  }

  const symbolCounts = new Map()
  for (const node of nodes) symbolCounts.set(node.path, (symbolCounts.get(node.path) ?? 0) + 1)

  for (const path of files) {
    const area = areaOf(path, config)
    const areaId = `area:${area}`
    if (!out.has(areaId)) out.set(areaId, { id: areaId, kind: 'area', name: area })
    out.set(`file:${path}`, {
      id: `file:${path}`,
      kind: 'file',
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      area,
      symbols: symbolCounts.get(path) ?? 0,
    })
    edges.push({ from: areaId, to: `file:${path}`, kind: 'contains' })
  }

  for (const { from, to } of imports) {
    if (!out.has(`file:${from}`) || !out.has(`file:${to}`)) continue
    edges.push({ from: `file:${from}`, to: `file:${to}`, kind: 'imports' })
  }

  return {
    nodes: [...out.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    edges: edges.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : a.from < b.from ? -1 : a.from > b.from ? 1 : 0)),
  }
}
