import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const STATE_VERSION = 1

const STATE_FILE = '.state.json'

/** Reads the previous run's state, or null when there is none or it is unreadable. */
export function readState(atlasDir) {
  try {
    return JSON.parse(readFileSync(join(atlasDir, STATE_FILE), 'utf8'))
  } catch {
    return null
  }
}

export function writeState(atlasDir, state) {
  mkdirSync(atlasDir, { recursive: true })
  writeFileSync(join(atlasDir, STATE_FILE), JSON.stringify(state, null, 2) + '\n')
}

/**
 * Decides which files need extraction. A file is skipped only when its blob hash
 * is unchanged and the working tree is clean for it.
 */
export function planWork(prev, files, dirty, indexable) {
  const usable = prev && prev.version === STATE_VERSION ? prev.files : {}
  const toExtract = []
  const unchanged = []

  for (const [path, sha] of files) {
    if (!indexable(path)) continue
    if (usable[path] === sha && !dirty.has(path)) unchanged.push(path)
    else toExtract.push(path)
  }

  const removed = Object.keys(usable).filter((path) => !files.has(path))

  toExtract.sort()
  unchanged.sort()
  removed.sort()
  return { toExtract, unchanged, removed }
}
