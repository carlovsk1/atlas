#!/usr/bin/env node
// PreToolUse hook on Write. Reads the symbols the new file is about to export and, when
// the repository already exports one of those names, denies the write once with the
// locations attached. The gate is not "go and check": the check has already run and its
// answer is the reason.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute, extname } from 'node:path'
import { extractFile } from '../scripts/lib/extract.mjs'
import { loadGraph, findSymbol } from '../scripts/lib/query.mjs'
import { record } from '../scripts/lib/ledger.mjs'
import { collidable } from '../scripts/lib/rules.mjs'

process.on('uncaughtException', () => process.exit(0))

const REPORTED = 3
const CODE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs'])

const allow = () => process.exit(0)

let hook
try {
  hook = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  allow()
}

const target = hook.tool_input?.file_path
const content = hook.tool_input?.content
if (!target || typeof content !== 'string' || !CODE.has(extname(target))) allow()

// Writing over a file that exists is an edit, and editing is what --rdeps is for.
if (existsSync(target)) allow()

const repo = hook.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
const atlasDir = join(repo, '.claude', 'atlas')
const path = relative(repo, isAbsolute(target) ? target : join(repo, target))
if (path.startsWith('..')) allow()

let graph
try {
  graph = loadGraph(atlasDir)
} catch {
  allow()
}

// ponytail: one marker per file per session, so a deliberate second attempt goes
// through. Without it a model that decides to create the file anyway would retry into
// a wall forever. Ceiling: the markers are never cleaned up; they are empty files.
const marker = join(atlasDir, '.gate', `${hook.session_id ?? 'session'}-${path.replace(/[^\w.-]/g, '_')}`)
if (existsSync(marker)) allow()

const collisions = []
for (const node of extractFile(path, content)) {
  if (!collidable(node)) continue
  const existing = findSymbol(graph, node.name).filter((m) => m.name === node.name && m.path !== path)
  if (existing.length) collisions.push({ name: node.name, existing })
}

if (collisions.length === 0) allow()

try {
  mkdirSync(join(atlasDir, '.gate'), { recursive: true })
  writeFileSync(marker, '')
} catch {
  // An unwritable index directory is not a reason to block someone's work.
  allow()
}

for (const { name, existing } of collisions) {
  record(atlasDir, {
    kind: 'gate',
    session: hook.session_id,
    name,
    at: `${existing[0].path}:${existing[0].line}`,
    file: path,
  })
}

const lines = [`Atlas: this repository already exports ${collisions.length === 1 ? 'this name' : 'these names'}.`]
for (const { name, existing } of collisions.slice(0, REPORTED)) {
  lines.push(`\n${name}:`)
  for (const m of existing.slice(0, REPORTED)) lines.push(`  ${m.path}:${m.line}  ${m.kind}`)
  if (existing.length > REPORTED) lines.push(`  ... and ${existing.length - REPORTED} more`)
}
if (collisions.length > REPORTED) lines.push(`\n... and ${collisions.length - REPORTED} more names`)
lines.push(
  '',
  'Open one of those files and reuse it, or say why a new one is needed and write again.',
  'This gate fires once per file, so the same write will go through next time.'
)

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: lines.join('\n'),
    },
  })
)
