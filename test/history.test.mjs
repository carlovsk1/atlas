import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileHistory, churnHotspots, decisionCandidates } from '../scripts/lib/history.mjs'

const DAY = 86400000
const BASE = Date.parse('2024-01-01T00:00:00Z')

/** A repository with an explicit clock, so ordering never depends on the real one. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-history-'))
  let tick = 0
  const git = (args, env) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, ...env } })

  git(['init', '-q'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])

  const stamp = () => {
    const date = new Date(BASE + tick++ * DAY).toISOString()
    return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  }

  const write = (path, body) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }

  const commit = (message, files = {}) => {
    for (const [path, body] of Object.entries(files)) write(path, body)
    git(['add', '-A'])
    git(['commit', '-q', '-m', message], stamp())
  }

  const sha = (rev = 'HEAD') => execFileSync('git', ['rev-parse', rev], { cwd: dir, encoding: 'utf8' }).trim()

  const revert = (target) => git(['revert', '--no-edit', target], stamp())

  return { dir, git, commit, sha, revert }
}

/** The shape every scenario below reads from: one file corrected over and over. */
function repoWithSignals() {
  const repo = makeRepo()
  repo.commit('feat: add pricing engine', { 'src/pricing.ts': 'v1\n', 'src/stable.ts': 'never changes\n' })
  repo.commit('fix: pricing rounded the wrong way', { 'src/pricing.ts': 'v2\n' })
  repo.commit('feat: add discounts', { 'src/discounts.ts': 'v1\n' })
  repo.commit('fix(pricing): off by one on tax', { 'src/pricing.ts': 'v3\n' })
  repo.commit('chore: bump deps', { 'package.json': '{}\n' })
  repo.commit('Correct the pricing regression', { 'src/pricing.ts': 'v4\n' })
  return repo
}

test('fileHistory returns commits newest first with sha, date, subject, and author', () => {
  const repo = repoWithSignals()
  const history = fileHistory(repo.dir, 'src/pricing.ts')

  assert.equal(history.length, 4)
  assert.deepEqual(
    history.map((commit) => commit.subject),
    ['Correct the pricing regression', 'fix(pricing): off by one on tax', 'fix: pricing rounded the wrong way', 'feat: add pricing engine']
  )
  assert.match(history[0].sha, /^[0-9a-f]{40}$/)
  assert.equal(history[0].author, 'Test')
  assert.equal(history.at(-1).date.slice(0, 10), '2024-01-01')
})

test('fileHistory honours limit', () => {
  const repo = repoWithSignals()
  assert.equal(fileHistory(repo.dir, 'src/pricing.ts', { limit: 2 }).length, 2)
})

test('fileHistory follows a rename', () => {
  const repo = repoWithSignals()
  mkdirSync(join(repo.dir, 'src', 'billing'))
  repo.git(['mv', 'src/pricing.ts', 'src/billing/pricing.ts'])
  repo.commit('refactor: move pricing under billing')

  const followed = fileHistory(repo.dir, 'src/billing/pricing.ts')
  assert.equal(followed.length, 5, 'history should survive the rename')
  assert.equal(followed.at(-1).subject, 'feat: add pricing engine')
})

test('fileHistory returns nothing for a path git does not know', () => {
  const repo = repoWithSignals()
  assert.deepEqual(fileHistory(repo.dir, 'src/does-not-exist.ts'), [])
})

test('churnHotspots reports commit and corrective counts with the shas behind them', () => {
  const repo = repoWithSignals()
  const hotspots = churnHotspots(repo.dir)

  assert.equal(hotspots.length, 1)
  const [pricing] = hotspots
  assert.equal(pricing.path, 'src/pricing.ts')
  assert.equal(pricing.commits, 4)
  assert.equal(pricing.corrective, 3, 'two fix: prefixes plus one plain-language correction')
  assert.equal(pricing.shas.length, 3)
  for (const sha of pricing.shas) assert.match(sha, /^[0-9a-f]{40}$/)
})

test('churnHotspots ignores files that were touched once', () => {
  const repo = repoWithSignals()
  const paths = churnHotspots(repo.dir).map((hotspot) => hotspot.path)
  assert.ok(!paths.includes('src/stable.ts'))
  assert.ok(!paths.includes('src/discounts.ts'))
})

test('churnHotspots honours limit and stays deterministic across runs', () => {
  const repo = repoWithSignals()
  repo.commit('feat: add invoices', { 'src/invoices.ts': 'v1\n' })
  repo.commit('fix: invoice total ignored credits', { 'src/invoices.ts': 'v2\n' })
  repo.commit('fix: invoice total still ignored credits', { 'src/invoices.ts': 'v3\n' })

  assert.deepEqual(churnHotspots(repo.dir), churnHotspots(repo.dir))
  assert.equal(churnHotspots(repo.dir).length, 2)
  assert.equal(churnHotspots(repo.dir, { limit: 1 })[0].path, 'src/pricing.ts', 'most corrective first')
})

test('decisionCandidates flags a repeatedly fixed file and cites the commits', () => {
  const repo = repoWithSignals()
  const candidates = decisionCandidates(repo.dir)

  assert.equal(candidates.length, 1)
  const [pricing] = candidates
  assert.equal(pricing.path, 'src/pricing.ts')
  assert.equal(pricing.signal, 'repeatedly-fixed')
  assert.equal(pricing.commits.length, 3)
  assert.deepEqual(Object.keys(pricing.commits[0]), ['sha', 'subject', 'date'])
  assert.equal(pricing.commits[0].subject, 'Correct the pricing regression')
})

test('decisionCandidates flags a reverted file and cites the revert itself', () => {
  const repo = makeRepo()
  repo.commit('feat: add cache layer', { 'src/cache.ts': 'v1\n' })
  repo.commit('feat: use the cache in reports', { 'src/cache.ts': 'v2\n' })
  const target = repo.sha()
  repo.revert(target)

  const candidates = decisionCandidates(repo.dir)
  assert.equal(candidates.length, 1)
  const [cache] = candidates
  assert.equal(cache.path, 'src/cache.ts')
  assert.equal(cache.signal, 'reverted')
  assert.equal(cache.commits[0].subject, 'Revert "feat: use the cache in reports"')
  assert.equal(cache.commits[0].sha, repo.sha())
})

test('decisionCandidates ranks by correction volume, with reverted breaking ties', () => {
  const repo = makeRepo()
  // Four correctives, no revert.
  repo.commit('feat: add pricing', { 'src/pricing.ts': 'v1\n' })
  for (const n of [2, 3, 4, 5]) repo.commit(`fix: pricing pass ${n}`, { 'src/pricing.ts': `v${n}\n` })
  // Three correctives, one of them a revert.
  repo.commit('feat: add cache', { 'src/cache.ts': 'v1\n' })
  for (const n of [2, 3]) repo.commit(`fix: cache pass ${n}`, { 'src/cache.ts': `v${n}\n` })
  repo.revert(repo.sha())
  // Three correctives, no revert: same count as the cache, so the tie is broken.
  repo.commit('feat: add mailer', { 'src/mailer.ts': 'v1\n' })
  for (const n of [2, 3, 4]) repo.commit(`fix: mailer pass ${n}`, { 'src/mailer.ts': `v${n}\n` })

  assert.deepEqual(
    decisionCandidates(repo.dir).map((candidate) => [candidate.path, candidate.signal]),
    [
      ['src/pricing.ts', 'repeatedly-fixed'],
      ['src/cache.ts', 'reverted'],
      ['src/mailer.ts', 'repeatedly-fixed'],
    ]
  )
})

test('reverting a whole branch is not a per-file signal', () => {
  const repo = makeRepo()
  const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`src/mod-${i}.ts`, 'v1\n']))
  repo.commit('feat: land the whole branch', wide)
  repo.revert(repo.sha())

  assert.deepEqual(decisionCandidates(repo.dir), [], '40 files at once is a branch rollback, not 40 decisions')
})

test('decisionCandidates says nothing about a file with a quiet history', () => {
  const repo = makeRepo()
  repo.commit('feat: add a thing', { 'src/thing.ts': 'v1\n' })
  repo.commit('feat: extend the thing', { 'src/thing.ts': 'v2\n' })
  assert.deepEqual(decisionCandidates(repo.dir), [])
})

test('paths containing spaces and quotes survive parsing', () => {
  const repo = makeRepo()
  const path = 'src/a file "quoted".ts'
  repo.commit('feat: add it', { [path]: 'v1\n' })
  repo.commit('fix: it was broken', { [path]: 'v2\n' })
  repo.commit('fix: it was still broken', { [path]: 'v3\n' })
  repo.commit('fix: broken one more time', { [path]: 'v4\n' })

  assert.equal(churnHotspots(repo.dir)[0].path, path)
  assert.equal(decisionCandidates(repo.dir)[0].path, path)
  assert.equal(fileHistory(repo.dir, path).length, 4)
})

test('a repository with no commits yields empty results instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-history-'))
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })

  assert.deepEqual(fileHistory(dir, 'src/anything.ts'), [])
  assert.deepEqual(churnHotspots(dir), [])
  assert.deepEqual(decisionCandidates(dir), [])
})

test('a directory that is not a repository yields empty results instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-history-'))
  assert.deepEqual(churnHotspots(dir), [])
  assert.deepEqual(decisionCandidates(dir), [])
})

test('a shallow clone reports only the history it has', () => {
  const origin = repoWithSignals()
  const dir = mkdtempSync(join(tmpdir(), 'atlas-history-'))
  const clone = join(dir, 'shallow')
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${origin.dir}`, clone], { stdio: 'ignore' })

  assert.deepEqual(churnHotspots(clone), [], 'one commit of history cannot show churn')
  assert.equal(fileHistory(clone, 'src/pricing.ts').length, 1)
})

test('a repo path that does not exist is a caller bug and throws', () => {
  assert.throws(() => churnHotspots('/nope/not/a/directory'), { code: 'ENOENT' })
  assert.throws(() => decisionCandidates('/nope/not/a/directory'), { code: 'ENOENT' })
  assert.throws(() => fileHistory('/nope/not/a/directory', 'src/a.ts'), { code: 'ENOENT' })
})

test('since narrows the window both aggregates look at', () => {
  const repo = repoWithSignals()
  assert.equal(churnHotspots(repo.dir, { since: '2024-01-05' }).length, 0, 'only two commits remain in range')
  assert.equal(churnHotspots(repo.dir, { since: '2023-01-01' }).length, 1)
})
