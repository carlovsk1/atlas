#!/usr/bin/env node
// UserPromptSubmit hook. States that an index exists and how to ask it, every turn, so
// consulting Atlas does not depend on the model remembering to. Kept to a few lines
// because this is paid for on every single prompt.
//
// When the prompt itself names something, the lookup has already run by the time the
// model reads this: the answer is here, not an instruction to go and get it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGraph, findSymbol, dependents } from '../scripts/lib/query.mjs'
import { record } from '../scripts/lib/ledger.mjs'

process.on('uncaughtException', () => process.exit(0))

const CLI = fileURLToPath(new URL('../scripts/atlas.mjs', import.meta.url))

// Same floor as the gate: `id` and `db` collide by accident.
const MIN_NAME = 4
const MAX_TERMS = 3
const MAX_PATHS = 2
const MAX_HITS = 3
const MAX_DEPENDENTS = 5

// Names a person chose, not words they wrote: an internal capital, or backticks around
// it. Prose does not look like this, so a hit is a symbol worth searching for.
const IDENT = /`([\w$.-]{4,})`|\b[A-Za-z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g
const PATH = /\b[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z]\w*\b/g

function terms(text, pattern, limit) {
  const found = new Set()
  for (const match of text.matchAll(pattern)) {
    const term = match[1] ?? match[0]
    if (term.length >= MIN_NAME) found.add(term)
    if (found.size >= limit) break
  }
  return [...found]
}

/**
 * Runs --find on the names in the prompt and --rdeps on the paths, returning the lines
 * to append. Empty when the prompt names nothing, which is also when the graph is never
 * read: a prompt in prose costs exactly what it did before.
 */
function lookup(atlasDir, prompt, session) {
  const names = terms(prompt, IDENT, MAX_TERMS)
  const paths = terms(prompt, PATH, MAX_PATHS).filter((p) => !names.includes(p))
  if (names.length === 0 && paths.length === 0) return []

  // ponytail: parses the whole graph for at most five lookups. Sub-100ms on a 2k-file
  // repository; only worth a name index if this ever shows up as prompt latency.
  let graph
  try {
    graph = loadGraph(atlasDir)
  } catch {
    return []
  }

  const out = []
  for (const name of names) {
    const hits = findSymbol(graph, name, { limit: MAX_HITS })
    if (hits.total === 0) {
      out.push(`${name}: nothing in the index exports this`)
      continue
    }
    out.push(`${name}: ${hits.total} ${hits.total === 1 ? 'match' : 'matches'}`)
    for (const hit of hits) out.push(`  ${hit.path}:${hit.line}  ${hit.kind}`)
    if (hits.total > hits.length) out.push(`  ... and ${hits.total - hits.length} more`)
    record(atlasDir, { kind: 'find', session, name, at: `${hits[0].path}:${hits[0].line}`, matches: hits.total })
  }

  for (const path of paths) {
    const who = dependents(graph, path, { depth: 1 })
    if (who.unknown || who.length === 0) continue
    out.push(`${path} is imported by ${who.length} ${who.length === 1 ? 'file' : 'files'}`)
    record(atlasDir, { kind: 'rdeps', session, path, count: who.length })
    for (const file of who.slice(0, MAX_DEPENDENTS)) out.push(`  ${file.path}`)
    if (who.length > MAX_DEPENDENTS) out.push(`  ... and ${who.length - MAX_DEPENDENTS} more`)
  }

  if (out.length === 0) return []
  return ['', 'Atlas already looked up what your message names:', ...out]
}

let hook
try {
  hook = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

const repo = hook.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()

// INDEX.md rather than .state.json: it already carries the stamp line and is under a
// kilobyte, while state is megabytes on a large repository and this runs every turn.
let stamp
try {
  const index = readFileSync(join(repo, '.claude', 'atlas', 'INDEX.md'), 'utf8')
  stamp = index.split('\n').find((line) => line.startsWith('Indexed at'))
} catch {
  process.exit(0)
}

if (!stamp) process.exit(0)

const prompt = typeof hook.prompt === 'string' ? hook.prompt : hook.user_prompt

console.log(
  [
    `Atlas index available for this repository. ${stamp}`,
    `Ask it BEFORE grepping for where a symbol lives or who imports a file:`,
    `  node "${CLI}" --repo . --find <name>      does this already exist, and where`,
    `  node "${CLI}" --repo . --rdeps <path>     who breaks if I change this file`,
    `  node "${CLI}" --repo . --impact           blast radius of the working tree`,
    `Grep stays right for content the index does not hold: a class name, a string, a regex.`,
    `Never read .claude/atlas/*.md directly, it is far larger than any answer in it.`,
    ...(typeof prompt === 'string' ? lookup(join(repo, '.claude', 'atlas'), prompt, hook.session_id) : []),
  ].join('\n')
)
