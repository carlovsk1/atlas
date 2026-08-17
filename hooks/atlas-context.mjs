#!/usr/bin/env node
// UserPromptSubmit hook. States that an index exists and how to ask it, every turn, so
// consulting Atlas does not depend on the model remembering to. Kept to a few lines
// because this is paid for on every single prompt.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.on('uncaughtException', () => process.exit(0))

const CLI = fileURLToPath(new URL('../scripts/atlas.mjs', import.meta.url))

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

console.log(
  [
    `Atlas index available for this repository. ${stamp}`,
    `Ask it instead of reading .claude/atlas/*.md, which is far larger than the answer:`,
    `  node "${CLI}" --repo . --find <name>      does this already exist, and where`,
    `  node "${CLI}" --repo . --rdeps <path>     who breaks if I change this file`,
    `  node "${CLI}" --repo . --impact           blast radius of the working tree`,
  ].join('\n')
)
