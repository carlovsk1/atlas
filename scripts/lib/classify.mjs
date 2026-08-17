export const BUCKETS = ['components', 'hooks', 'routes', 'data', 'utils']

const TOP_LEVEL_AREAS = ['engine', 'supabase', 'scripts', 'src']

/** The inventory file a node belongs to, chosen by what the node is. */
export function bucketOf(node) {
  if (node.kind === 'route') return 'routes'
  if (node.kind === 'table' || node.kind === 'type' || node.kind === 'interface' || node.kind === 'enum') {
    return 'data'
  }
  if (/^use[A-Z]/.test(node.name)) return 'hooks'
  if (/^[A-Z]/.test(node.name) && /\.(tsx|jsx)$/.test(node.path)) return 'components'
  return 'utils'
}

/** Where in the repository a node came from. Config entries win over heuristics. */
export function areaOf(path, config = {}) {
  const overrides = config.areas ?? {}
  const prefixes = Object.keys(overrides).sort((a, b) => b.length - a.length)
  for (const prefix of prefixes) {
    if (path === prefix || path.startsWith(prefix + '/')) return overrides[prefix]
  }

  const parts = path.split('/')
  if ((parts[0] === 'apps' || parts[0] === 'packages') && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`
  }
  if (TOP_LEVEL_AREAS.includes(parts[0]) && parts.length > 1) return parts[0]
  return 'root'
}
