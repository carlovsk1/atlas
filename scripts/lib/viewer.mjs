import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { areaOf } from './classify.mjs'

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'viewer', 'graph.html')

/**
 * Shapes the graph for the browser: files as an index, edges as index pairs, and the
 * symbols of each file for the detail panel. Everything else in `graph.json` is
 * derivable from these three and would only make the page heavier.
 */
export function buildViewerData({ repo, root, commit, date, files, nodes, imports, config = {} }) {
  const position = new Map(files.map((path, i) => [path, i]))
  const symbols = files.map(() => [])

  for (const node of nodes) {
    const at = position.get(node.path)
    if (at !== undefined) symbols[at].push([node.name, node.kind, node.line])
  }

  const edges = []
  for (const { from, to } of imports) {
    const a = position.get(from)
    const b = position.get(to)
    if (a !== undefined && b !== undefined) edges.push([a, b])
  }

  return {
    repo,
    // Absolute, so the viewer can build `vscode://file/...` links out of the relative paths.
    root,
    commit,
    date,
    files: files.map((path) => [path, areaOf(path, config)]),
    symbols,
    edges,
  }
}

/** Inlines the data into the viewer template, so the page works from `file://` offline. */
export function renderViewer(data) {
  const json = JSON.stringify(data).replace(/<\//g, '<\\/')
  return readFileSync(TEMPLATE, 'utf8').replace('"__ATLAS_GRAPH__"', json)
}
