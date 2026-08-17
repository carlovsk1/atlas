#!/usr/bin/env node
// PostToolUse hook. Re-extracts the Atlas index after Claude Code edits a file, so the
// index never goes stale inside the session that is writing the code. An incremental
// update costs ~0.3s on a 2000-file repository, which is cheap enough to pay per edit.
import { readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { indexable } from '../scripts/atlas.mjs'
import { readState, STATE_VERSION } from '../scripts/lib/state.mjs'

// A failed refresh must never surface as a stack trace on the user's edit.
process.on('uncaughtException', () => process.exit(0))

const CLI = fileURLToPath(new URL('../scripts/atlas.mjs', import.meta.url))
// Under the 30s timeout declared in hooks.json, so the lock is always released by us.
const UPDATE_TIMEOUT_MS = 25_000
// ponytail: a lock file, not a real mutex. Ceiling: an edit that lands while a run is
// in flight is dropped rather than queued, and a run killed mid-flight blocks refreshes
// until the file is LOCK_STALE_MS old. Both self-heal on the next edit. Upgrade to a pid
// liveness check, or to coalescing the dropped edit, only if either one is ever observed.
const LOCK_STALE_MS = 60_000

function payload() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return null
  }
}

const hook = payload()
if (!hook) process.exit(0)

// ponytail: the session's cwd is taken as the repository root. A session opened in a
// subdirectory just finds no state and no-ops; walk upward if that ever matters.
const repo = hook.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
const atlasDir = join(repo, '.claude', 'atlas')

const state = readState(atlasDir)
// No state means no index, so the user never opted in and a hook must not nag. A version
// bump means a full re-extract, which is /atlas-init's decision to make, not a hook's.
if (!state || state.version !== STATE_VERSION) process.exit(0)

const edited = hook.tool_input?.file_path
if (!edited) process.exit(0)

// indexable() reads repository-relative paths: an absolute one would match its SKIP rule
// against directory names that live above the repository.
const path = relative(repo, isAbsolute(edited) ? edited : join(repo, edited))
if (path.startsWith('..') || !indexable(path)) process.exit(0)

const lock = join(atlasDir, '.freshen.lock')
try {
  writeFileSync(lock, String(process.pid), { flag: 'wx' })
} catch {
  try {
    if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) process.exit(0)
  } catch {
    // The holder released it between the two calls, so it is ours to take.
  }
  writeFileSync(lock, String(process.pid))
}

try {
  spawnSync(process.execPath, [CLI, '--repo', repo, '--update'], {
    stdio: 'ignore',
    timeout: UPDATE_TIMEOUT_MS,
  })
} finally {
  try {
    unlinkSync(lock)
  } catch {
    // Already gone. Nothing to release.
  }
}
