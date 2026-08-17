import { readFileSync } from 'node:fs'
import { join, dirname, normalize } from 'node:path'

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

const SPEC_RULES = [
  /^\s*(?:import|export)\b[^'"]*\bfrom\s*['"]([^'"]+)['"]/,
  /^\s*import\s*['"]([^'"]+)['"]/,
  // The `from` line of a multi-line import, whose `import {` opened several lines up.
  /^\s*\}?\s*from\s*['"]([^'"]+)['"]/,
  /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/,
]

/** Every module specifier a file imports, in source order, without repeats. */
export function extractImports(content) {
  const specs = new Set()

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    for (const rule of SPEC_RULES) {
      const m = line.match(rule)
      if (m) {
        specs.add(m[1])
        break
      }
    }
  }

  return [...specs]
}

/**
 * Parses a tsconfig, which is JSON with comments and trailing commas. The scan tracks
 * string state rather than pattern-matching the text: a regex cannot tell the `/*` that
 * opens a comment from the one inside `"@/*"`, and every Next.js tsconfig has both that
 * alias and a `"**\/*.ts"` include for the regex to run between.
 */
function parseJsonc(text) {
  let out = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else if (char === ',') {
      let next = i + 1
      while (next < text.length && /\s/.test(text[next])) next++
      if (text[next] !== '}' && text[next] !== ']') out += char
    } else {
      out += char
    }
  }

  return JSON.parse(out)
}

function readJsonc(repo, path) {
  try {
    return parseJsonc(readFileSync(join(repo, path), 'utf8'))
  } catch {
    return null
  }
}

/** Every directory that holds or contains an indexed file, plus the repository root. */
function ancestorDirs(files) {
  const dirs = new Set([''])
  for (const path of files) {
    const parts = path.split('/')
    parts.pop()
    let acc = ''
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      dirs.add(acc)
    }
  }
  return dirs
}

function relative(...parts) {
  const path = normalize(join(...parts))
  return path === '.' ? '' : path.replace(/\/+$/, '')
}

/**
 * Alias entries from every tsconfig in the tree. An entry is scoped to the directory
 * of the tsconfig that declared it, so `@/` means one thing in one package and
 * something else in the next. `extends` is not followed.
 */
function readAliases(repo, dirs) {
  const aliases = []

  for (const dir of dirs) {
    const config = readJsonc(repo, join(dir, 'tsconfig.json'))
    const paths = config?.compilerOptions?.paths
    if (!paths) continue
    const baseUrl = config.compilerOptions.baseUrl ?? '.'

    for (const [key, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets)) continue
      aliases.push({
        dir,
        prefix: key.replace(/\*$/, ''),
        wildcard: key.endsWith('*'),
        targets: targets.map((t) => relative(dir, baseUrl, t.replace(/\*$/, ''))),
      })
    }
  }

  return aliases.sort((a, b) => b.dir.length - a.dir.length || b.prefix.length - a.prefix.length)
}

/** Workspace packages, so an import by package name lands inside this repository. */
function readPackages(repo, dirs) {
  const packages = []

  for (const dir of dirs) {
    const pkg = readJsonc(repo, join(dir, 'package.json'))
    if (pkg?.name) packages.push({ name: pkg.name, dir })
  }

  return packages.sort((a, b) => b.name.length - a.name.length)
}

/**
 * Resolves module specifiers against the set of files Atlas indexed, never against
 * the disk: anything that resolves outside that set (a dependency, a type-only
 * package, a missing file) is not part of this repository's graph and returns null.
 */
export function buildResolver(repo, files) {
  const dirs = ancestorDirs(files)
  const aliases = readAliases(repo, dirs)
  const packages = readPackages(repo, dirs)

  const tryFile = (base) => {
    if (!base) return null
    if (files.has(base)) return base
    for (const ext of EXTS) if (files.has(base + ext)) return base + ext

    const emitted = base.match(/\.(js|jsx|mjs|cjs)$/)
    if (emitted) {
      const stem = base.slice(0, -emitted[0].length)
      for (const ext of EXTS) if (files.has(stem + ext)) return stem + ext
    }

    for (const ext of EXTS) if (files.has(`${base}/index${ext}`)) return `${base}/index${ext}`
    return null
  }

  const candidates = (spec, fromPath) => {
    if (spec.startsWith('.')) return [relative(dirname(fromPath), spec)]

    for (const alias of aliases) {
      if (alias.dir && !fromPath.startsWith(`${alias.dir}/`)) continue
      if (alias.wildcard ? !spec.startsWith(alias.prefix) : spec !== alias.prefix) continue
      const rest = alias.wildcard ? spec.slice(alias.prefix.length) : ''
      return alias.targets.map((target) => relative(target, rest))
    }

    for (const pkg of packages) {
      if (spec !== pkg.name && !spec.startsWith(`${pkg.name}/`)) continue
      const rest = spec.slice(pkg.name.length + 1)
      return [relative(pkg.dir, rest), relative(pkg.dir, 'src', rest)]
    }

    return []
  }

  return (spec, fromPath) => {
    for (const base of candidates(spec, fromPath)) {
      const hit = tryFile(base)
      if (hit && hit !== fromPath) return hit
    }
    return null
  }
}
