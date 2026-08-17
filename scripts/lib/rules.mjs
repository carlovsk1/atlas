export const TS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs']

export const SYMBOL_RULES = [
  {
    exts: TS_EXTS,
    re: /^export\s+(?:default\s+)?(?:async\s+)?(function|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/,
    kind: (m) => (m[1] === 'let' ? 'const' : m[1]),
    name: (m) => m[2],
  },
  {
    exts: ['.py'],
    re: /^(?:def|class)\s+([A-Za-z][\w]*)/,
    kind: () => 'function',
    name: (m) => m[1],
  },
]

export const TABLE_RULES = [
  {
    exts: ['.sql'],
    re: /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:[\w"]+\.)?["']?(\w+)["']?/i,
    name: (m) => m[1],
  },
  {
    exts: TS_EXTS,
    re: /pgTable\(\s*["'](\w+)["']/,
    name: (m) => m[1],
  },
  {
    exts: ['.prisma'],
    re: /^model\s+(\w+)/,
    name: (m) => m[1],
  },
]

export const DECORATOR_ROUTE_RULES = [
  {
    exts: ['.py'],
    re: /^@(?:app|router)\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/,
    name: (m) => `${m[1].toUpperCase()} ${m[2]}`,
  },
  {
    exts: TS_EXTS,
    re: /^\s*(?:app|router)\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/,
    name: (m) => `${m[1].toUpperCase()} ${m[2]}`,
  },
]

/**
 * Derives a Next App Router path from a file path, or null when the file is not
 * a route. Anchors on the rightmost `app` segment so a package directory that is
 * itself named `app` does not leak into the route. Route groups in parentheses
 * are dropped.
 */
export function nextRoutePath(path) {
  const file = path.match(/\/(page|route)\.(tsx?|jsx?)$/)
  if (!file) return null
  const segments = path.slice(0, path.length - file[0].length).split('/')
  const appIndex = segments.lastIndexOf('app')
  if (appIndex === -1) return null
  const rest = segments
    .slice(appIndex + 1)
    .filter((s) => !(s.startsWith('(') && s.endsWith(')')))
  return '/' + rest.join('/')
}
