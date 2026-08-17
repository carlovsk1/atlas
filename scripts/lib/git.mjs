import { execFileSync } from 'node:child_process'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** Map of repo-relative path to git blob sha for tracked files, plus untracked files marked `untracked`. */
export function listFiles(cwd) {
  const files = new Map()

  const tracked = git(cwd, ['ls-files', '-s'])
  for (const line of tracked.split('\n')) {
    if (!line) continue
    // Format: <mode> <sha> <stage>\t<path>
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    const sha = line.slice(0, tab).split(' ')[1]
    files.set(line.slice(tab + 1), sha)
  }

  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard'])
  for (const path of untracked.split('\n')) {
    if (path && !files.has(path)) files.set(path, 'untracked')
  }

  return files
}

/** Paths modified, added, or untracked in the working tree. */
export function dirtyFiles(cwd) {
  const out = git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])
  const dirty = new Set()
  for (const entry of out.split('\0')) {
    if (entry.length < 4) continue
    dirty.add(entry.slice(3))
  }
  return dirty
}

/** Current HEAD sha, or null when the repository has no commits yet. */
export function headSha(cwd) {
  try {
    return git(cwd, ['rev-parse', 'HEAD']).trim()
  } catch {
    return null
  }
}
