import { appendFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { collidable } from './rules.mjs'

const LEDGER_FILE = '.ledger.jsonl'

/**
 * Appends one assist. Silent on every failure, like the hooks that call it: a ledger
 * Atlas cannot write is never a reason an edit did not happen.
 *
 * ponytail: one `appendFileSync` of a sub-4KB line, which POSIX `O_APPEND` keeps whole
 * even with several hooks writing at once. Reach for a lock only if a reader ever sees
 * interleaved lines, which `readLedger` already survives by dropping them.
 */
export function record(atlasDir, event) {
  try {
    mkdirSync(atlasDir, { recursive: true })
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event })
    appendFileSync(join(atlasDir, LEDGER_FILE), `${line}\n`)
  } catch {
    // Recording an assist must never fail louder than the assist itself was worth.
  }
}

/** Every readable event, oldest first. A torn line costs itself and nothing else. */
export function readLedger(atlasDir) {
  let raw
  try {
    raw = readFileSync(join(atlasDir, LEDGER_FILE), 'utf8')
  } catch {
    return []
  }

  const events = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      continue
    }
  }
  return events
}

/**
 * Names this repository exports from more than one file, right now. The one number here
 * that does not depend on Atlas reporting on itself: anyone can recount it from the
 * graph, and it falls when the duplication Atlas points at actually gets resolved.
 *
 * Counts exactly what the gate would stop, so the metric and the hook cannot disagree
 * about what duplication is.
 */
export function duplicateNames(graph) {
  const paths = new Map()
  for (const node of graph.symbols) {
    if (!collidable(node)) continue
    const seen = paths.get(node.name)
    if (seen) seen.add(node.path)
    else paths.set(node.name, new Set([node.path]))
  }

  let count = 0
  for (const files of paths.values()) if (files.size > 1) count++
  return count
}
