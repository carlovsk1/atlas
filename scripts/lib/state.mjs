import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const STATE_VERSION = 2

const STATE_FILE = '.state.json'

/** Reads the previous run's state, or null when there is none or it is unreadable. */
export function readState(atlasDir) {
  try {
    return JSON.parse(readFileSync(join(atlasDir, STATE_FILE), 'utf8'))
  } catch {
    return null
  }
}

function sortKeys(obj) {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]))
}

/**
 * Writes state to atlasDir, creating the directory if it does not exist. Keys of
 * `files` and `nodesByFile` are sorted so a single re-extracted file produces a
 * minimal diff instead of migrating to the end of the object.
 */
export function writeState(atlasDir, state) {
  mkdirSync(atlasDir, { recursive: true })
  const sorted = { ...state, files: sortKeys(state.files), nodesByFile: sortKeys(state.nodesByFile) }
  if (state.importsByFile) sorted.importsByFile = sortKeys(state.importsByFile)
  writeFileSync(join(atlasDir, STATE_FILE), JSON.stringify(sorted, null, 2) + '\n')
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

  const removed = Object.keys(usable).filter((path) => !files.has(path) || !indexable(path))

  toExtract.sort()
  unchanged.sort()
  removed.sort()
  return { toExtract, unchanged, removed }
}
