import { execFileSync } from 'node:child_process'

// Evidence, never prose. Every item returned here carries the shas that support
// it, so the model that writes a decision file can cite a real commit or write
// nothing at all.

const FIELD = '\x1f'

/**
 * A commit subject that signals a correction. Two branches: the Conventional
 * Commit `fix:` / `revert:` prefixes, and a short list of plain-language markers
 * for repositories that do not use them.
 * ponytail: subject-line heuristic, nothing semantic. It over-counts a team that
 * writes "fix" loosely and misses one that writes "correct the rounding".
 * Tighten by dropping the second branch and demanding the prefix form.
 */
const CORRECTIVE_SUBJECT =
  /^(?:fix|revert)(?:\([^)]*\))?!?:|\b(?:fix|fixes|fixed|hotfix|bugfix|regression|revert|reverts|reverted)\b/i

/** Narrower: a commit that undoes an earlier one. `git revert` writes the second form. */
const REVERT_SUBJECT = /^revert(?:\([^)]*\))?!?:|^revert\s+["']/i

// Thresholds. Deliberately low so a small repository still produces signal.
// ponytail: fixed numbers, not percentiles. A repository with a very long
// history will want these scaled; make them options when that shows up.
const HOTSPOT_MIN_COMMITS = 3
const HOTSPOT_MIN_CORRECTIVE = 2
const CANDIDATE_MIN_CORRECTIVE = 3
const SHAS_PER_HOTSPOT = 10
const COMMITS_PER_CANDIDATE = 5

/**
 * A revert only says something about a file when it was aimed at that file.
 * Reverting a merged branch touches hundreds of paths and means "we rolled back
 * a feature", not "this file holds a contested rule". Measured on a real
 * repository: branch reverts touched 63 to 226 files, targeted ones 6 to 7.
 * ponytail: a flat cut, not a ratio against repo size. Revisit if a repo is
 * small enough that a real revert legitimately spans more than this.
 */
const REVERT_MAX_PATHS = 25

/** Ceiling on the whole-repo walk, so a decade-old repository cannot stall a run. */
const MAX_COMMITS = 5000

const SIGNAL_RANK = { reverted: 0, 'repeatedly-fixed': 1 }

// ponytail: copied from git.mjs rather than exported from it, to keep this file
// addable without touching the module another process owns. Merge them later.
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * Anything git answers with a non-zero status (no commits yet, not a repository,
 * a shallow clone that runs out of history) is an empty result, not a crash. A
 * repo path that does not exist is a caller bug and still throws.
 */
function tryGit(cwd, args) {
  try {
    return git(cwd, args)
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw err
    return null
  }
}

/**
 * One `git log` pass over the whole repository: each commit with the paths it
 * touched. Merges are excluded so a squash-merge workflow does not count the
 * same change twice.
 *
 * Output shape is `\0<sha>\x1f<date>\x1f<subject>\0[\n<path>\0...]`, so an empty
 * token is a record boundary, the token after it is the header, and the rest are
 * paths. `-z` is what keeps a path containing a space or a quote intact.
 */
function walkCommits(repo, since) {
  const args = [
    'log',
    '--no-merges',
    '--name-only',
    '-z',
    `--format=%x00%H${FIELD}%aI${FIELD}%s`,
    `--max-count=${MAX_COMMITS}`,
  ]
  if (since) args.push(`--since=${since}`)

  const out = tryGit(repo, args)
  if (!out) return []

  const parts = out.split('\0')
  const commits = []
  let i = 0
  while (i < parts.length) {
    if (parts[i] === '') {
      i++
      continue
    }
    const [sha, date, ...rest] = parts[i++].split(FIELD)
    const paths = []
    while (i < parts.length && parts[i] !== '') {
      // git glues a newline to the first path of the diff; it is not part of it.
      const path = parts[i++].replace(/^\n/, '')
      if (path) paths.push(path)
    }
    commits.push({ sha, date, subject: rest.join(FIELD), paths })
  }
  return commits
}

/** Per-path counts and the corrective commits behind them, newest first. */
function tally(repo, since) {
  const stats = new Map()
  for (const commit of walkCommits(repo, since)) {
    const corrective = CORRECTIVE_SUBJECT.test(commit.subject)
    const reverted = REVERT_SUBJECT.test(commit.subject) && commit.paths.length <= REVERT_MAX_PATHS
    for (const path of commit.paths) {
      let stat = stats.get(path)
      if (!stat) {
        stat = { path, commits: 0, corrective: 0, reverted: false, evidence: [] }
        stats.set(path, stat)
      }
      stat.commits++
      if (reverted) stat.reverted = true
      if (corrective) {
        stat.corrective++
        stat.evidence.push({ sha: commit.sha, subject: commit.subject, date: commit.date, revert: reverted })
      }
    }
  }
  return stats
}

/** Commits that touched one file, newest first. */
export function fileHistory(repo, path, { limit = 20 } = {}) {
  // --follow accepts exactly one pathspec, so this is per-file by construction
  // and cannot be batched. The aggregate functions below never call it.
  const out = tryGit(repo, [
    'log',
    '--follow',
    '-z',
    `--format=%H${FIELD}%aI${FIELD}%an${FIELD}%s`,
    `--max-count=${limit}`,
    '--',
    path,
  ])
  if (!out) return []

  return out
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const [sha, date, author, ...rest] = record.split(FIELD)
      return { sha, date, subject: rest.join(FIELD), author }
    })
}

/**
 * Files whose history says they are unstable: many commits, and repeated
 * corrective ones. `shas` are the corrective commits, newest first, capped.
 * One `git log` invocation for the whole repository.
 */
export function churnHotspots(repo, { limit = 20, since = null } = {}) {
  const rows = []
  for (const stat of tally(repo, since).values()) {
    if (stat.commits < HOTSPOT_MIN_COMMITS) continue
    if (stat.corrective < HOTSPOT_MIN_CORRECTIVE) continue
    rows.push({
      path: stat.path,
      commits: stat.commits,
      corrective: stat.corrective,
      shas: stat.evidence.slice(0, SHAS_PER_HOTSPOT).map((commit) => commit.sha),
    })
  }

  rows.sort(
    (a, b) => b.corrective - a.corrective || b.commits - a.commits || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  )
  return rows.slice(0, limit)
}

/**
 * Files whose history suggests a decision was made and re-made: the same area
 * corrected over and over, which is where an undocumented rule usually hides.
 * `signal` is machine-readable on purpose. Writing the sentence is the model's
 * job, and it has the commits here to write it from.
 * One `git log` invocation for the whole repository.
 */
export function decisionCandidates(repo, { limit = 15, since = null } = {}) {
  const cite = ({ sha, subject, date }) => ({ sha, subject, date })
  const rows = []

  for (const stat of tally(repo, since).values()) {
    const signal = stat.reverted
      ? 'reverted'
      : stat.corrective >= CANDIDATE_MIN_CORRECTIVE
        ? 'repeatedly-fixed'
        : null
    if (!signal) continue

    // A "reverted" claim has to be able to cite the revert itself, so those
    // commits jump the cap. Both passes keep the newest-first order.
    const evidence =
      signal === 'reverted'
        ? [...stat.evidence.filter((commit) => commit.revert), ...stat.evidence.filter((commit) => !commit.revert)]
        : stat.evidence

    rows.push({
      corrective: stat.corrective,
      item: { path: stat.path, signal, commits: evidence.slice(0, COMMITS_PER_CANDIDATE).map(cite) },
    })
  }

  // Correction volume leads, the signal only breaks ties. Ranking reverts first
  // instead buried every repeatedly-fixed file on a real repository: 43 reverted
  // paths filled the whole page before the file with 54 corrective commits.
  rows.sort(
    (a, b) =>
      b.corrective - a.corrective ||
      SIGNAL_RANK[a.item.signal] - SIGNAL_RANK[b.item.signal] ||
      (a.item.path < b.item.path ? -1 : a.item.path > b.item.path ? 1 : 0)
  )
  return rows.slice(0, limit).map((row) => row.item)
}
