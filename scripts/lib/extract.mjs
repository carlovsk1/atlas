import { extname } from 'node:path'
import { SYMBOL_RULES, TABLE_RULES, DECORATOR_ROUTE_RULES, nextRoutePath } from './rules.mjs'

function stripCommentMarkers(line) {
  return line.replace(/^\/?\*+/, '').replace(/\*+\/$/, '').trim()
}

/** Finds the first content line of a `/** ... *\/` block that closes at lines[closeIndex]. */
function firstLineOfBlock(lines, closeIndex) {
  let start = -1
  for (let i = closeIndex - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith('/**')) {
      start = i
      break
    }
  }
  if (start === -1) return ''
  for (let i = start; i < closeIndex; i++) {
    const content = stripCommentMarkers(lines[i].trim())
    if (content) return content
  }
  return ''
}

/** Reads a JSDoc or line comment immediately above the declaration. */
function purposeAbove(lines, index) {
  for (let i = index - 1; i >= 0 && i >= index - 6; i--) {
    const line = lines[i].trim()
    if (!line) return ''
    if (line === '*/') return firstLineOfBlock(lines, i)
    if (line.startsWith('/**')) return stripCommentMarkers(line)
    if (line.startsWith('*')) return stripCommentMarkers(line)
    if (line.startsWith('//')) return line.replace(/^\/+/, '').trim()
    if (line.startsWith('#')) return line.replace(/^#+/, '').trim()
    return ''
  }
  return ''
}

function node(kind, name, path, line, purpose) {
  return { id: `${kind}:${path}#${name}`, kind, name, path, line, purpose }
}

function applies(rule, ext) {
  return rule.exts.includes(ext)
}

/** Extracts every node contained in a single file. */
export function extractFile(path, content) {
  const ext = extname(path)
  const lines = content.split('\n')
  const nodes = []
  const seen = new Set()

  const push = (n) => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    nodes.push(n)
  }

  const routePath = nextRoutePath(path)
  if (routePath) push(node('route', routePath, path, 1, ''))

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    for (const rule of SYMBOL_RULES) {
      if (!applies(rule, ext)) continue
      const m = line.match(rule.re)
      if (m) push(node(rule.kind(m), rule.name(m), path, i + 1, purposeAbove(lines, i)))
    }

    for (const rule of TABLE_RULES) {
      if (!applies(rule, ext)) continue
      const m = line.match(rule.re)
      if (m) push(node('table', rule.name(m), path, i + 1, ''))
    }

    for (const rule of DECORATOR_ROUTE_RULES) {
      if (!applies(rule, ext)) continue
      const m = line.match(rule.re)
      if (m) push(node('route', rule.name(m), path, i + 1, purposeAbove(lines, i)))
    }
  }

  return nodes
}
