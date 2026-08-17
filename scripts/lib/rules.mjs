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
    re: /^(def|class)\s+([A-Za-z][\w]*)/,
    kind: (m) => (m[1] === 'class' ? 'class' : 'function'),
    name: (m) => m[2],
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

// `export { A as B } from './x'` on one line. Deliberately line-based, like every other
// rule here: a multi-line export block yields nothing rather than a wrong answer.
const REEXPORT_RE = /^export\s+(?:type\s+)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/

/**
 * The names one re-export line republishes, each with the name it came from. A re-export
 * is the one construct where a symbol answers to two names, which is exactly what a
 * search for the original name has no other way of learning.
 */
export function reexportsIn(line) {
  const m = line.match(REEXPORT_RE)
  if (!m) return []

  const out = []
  for (const part of m[1].split(',')) {
    // `export { type D }` puts the modifier inside the braces, where it would otherwise
    // become part of the name and make the symbol unfindable by the name people type.
    const [source, alias] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)
    if (!source) continue
    out.push({ name: alias || source, source, from: m[2] })
  }
  return out
}

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

// Short names collide by accident: `id`, `db`, `type`. A collision is only worth a
// word when the name was specific enough to have been chosen.
const MIN_COLLISION_NAME = 4

/**
 * Names a framework makes you repeat. A file exporting `POST` is obeying the Next App
 * Router, not re-inventing the `POST` in the route next door, and every `page.tsx` in a
 * Next application exports `metadata`. Counting those as duplication would flag the
 * most ordinary file in the repository.
 */
export const CONVENTIONAL_NAMES = new Set([
  // Next App Router route handlers and file-level exports
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
  'metadata', 'generateMetadata', 'generateStaticParams', 'generateViewport', 'viewport',
  'revalidate', 'dynamic', 'dynamicParams', 'runtime', 'fetchCache', 'preferredRegion', 'maxDuration',
  // Next Pages Router
  'getServerSideProps', 'getStaticProps', 'getStaticPaths', 'middleware', 'config',
  // Serverless entry points
  'handler',
])

/**
 * Whether two symbols sharing this name is a real collision. The single definition of
 * what Atlas treats as duplication: the gate refuses to warn about anything this
 * rejects, and `--report` refuses to count it.
 */
export function collidable(node) {
  return (
    node.kind !== 'route' &&
    // A re-export is the opposite of duplication: it is one implementation answering to a
    // second name on purpose. Counting it would make consolidating a fork raise the
    // duplication number, which is backwards.
    node.kind !== 'reexport' &&
    node.name.length >= MIN_COLLISION_NAME &&
    !CONVENTIONAL_NAMES.has(node.name)
  )
}

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
