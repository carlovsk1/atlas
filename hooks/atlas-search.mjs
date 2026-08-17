#!/usr/bin/env node
// PreToolUse hook on Grep and Bash. Searching for a bare symbol name is a question the
// index has already answered, so the gate answers it and denies the search once, with
// the locations attached. Same stance as the write gate: not "go and check", but the
// check has run and its answer is the reason.
//
// Everything the index cannot answer goes straight through untouched — a regex, a class
// name, a string literal, a file name. Content is what grep is for, and walling that off
// would cost more than it saves.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGraph, findSymbol } from '../scripts/lib/query.mjs'
import { record } from '../scripts/lib/ledger.mjs'

process.on('uncaughtException', () => process.exit(0))

const CLI = fileURLToPath(new URL('../scripts/atlas.mjs', import.meta.url))

const REPORTED = 5
// Same floor as the context hook and the write gate: `id` and `db` collide by accident.
const MIN_NAME = 4
// A name someone chose, alone: no regex metacharacter, no path separator, no space. A
// pattern that fails this is a content search, which the index has no opinion about.
const IDENT = /^[A-Za-z_$][\w$]*$/
// The programs whose first argument is a pattern. `find` is absent on purpose: it
// matches file names, and a file name is not a symbol.
const SEARCHERS = /\b(?:grep|rg|ag|ack)\b/

const allow = () => process.exit(0)

/**
 * The searched term in a shell command: the first non-flag argument after the search
 * program, which is where grep, rg, ag and ack all take their pattern. Deliberately
 * dumb — a command it cannot read plainly yields null and the search runs.
 */
function bashNeedle(command) {
  if (typeof command !== 'string') return null
  const tokens = command.match(/'[^']*'|"[^"]*"|\S+/g) ?? []
  const start = tokens.findIndex((token) => SEARCHERS.test(token))
  if (start === -1) return null

  for (const token of tokens.slice(start + 1)) {
    if (token.startsWith('-')) continue
    const bare = token.replace(/^['"]|['"]$/g, '')
    return IDENT.test(bare) ? bare : null
  }
  return null
}

let hook
try {
  hook = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  allow()
}

const needle =
  hook.tool_name === 'Grep'
    ? hook.tool_input?.pattern
    : hook.tool_name === 'Bash'
      ? bashNeedle(hook.tool_input?.command)
      : null

if (typeof needle !== 'string' || !IDENT.test(needle) || needle.length < MIN_NAME) allow()

const repo = hook.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
const atlasDir = join(repo, '.claude', 'atlas')

let graph
try {
  graph = loadGraph(atlasDir)
} catch {
  allow()
}

// Exact matches only. `findSymbol` also ranks substring hits, and denying a search for
// `user` because forty symbols contain it would make the gate the thing people work
// around rather than the thing that answers them.
const hits = findSymbol(graph, needle).filter((match) => match.name === needle)
if (hits.length === 0) allow()

// ponytail: one marker per name per session, so a deliberate second search goes through.
// Without it a model that still wants the raw matches would retry into a wall forever.
// Ceiling: the markers are never cleaned up; they are empty files.
const marker = join(atlasDir, '.gate', `${hook.session_id ?? 'session'}-search-${needle}`)
if (existsSync(marker)) allow()

try {
  mkdirSync(join(atlasDir, '.gate'), { recursive: true })
  writeFileSync(marker, '')
} catch {
  // An unwritable index directory is not a reason to block someone's search.
  allow()
}

record(atlasDir, {
  kind: 'search',
  session: hook.session_id,
  name: needle,
  at: `${hits[0].path}:${hits[0].line}`,
  matches: hits.length,
})

const lines = [`Atlas: \`${needle}\` is indexed, so this search is already answered.`, '']
for (const hit of hits.slice(0, REPORTED)) lines.push(`  ${hit.path}:${hit.line}  ${hit.kind}`)
if (hits.length > REPORTED) lines.push(`  ... and ${hits.length - REPORTED} more`)
lines.push(
  '',
  `Open one of those, or ask who imports it: node "${CLI}" --repo . --rdeps <path>`,
  'This fires once per name, so searching for it again runs the search.'
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
