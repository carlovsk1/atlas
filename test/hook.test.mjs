import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync, execFileSync as run } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const HOOK = join(here, '..', 'hooks', 'atlas-freshen.mjs')
const CLI = join(here, '..', 'scripts', 'atlas.mjs')

const NEW_FILE = join('packages', 'utils', 'src', 'date.ts')

function stageFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-hook-'))
  cpSync(join(here, 'fixtures', 'sample-repo'), dir, { recursive: true })
  const git = (...args) => run('git', args, { cwd: dir })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
  return dir
}

function atlas(dir, ...args) {
  return execFileSync('node', [CLI, '--repo', dir, ...args], { encoding: 'utf8' })
}

/** Runs the hook exactly as Claude Code does: the payload arrives as JSON on stdin. */
function fire(dir, { file = NEW_FILE, tool = 'Edit', raw } = {}) {
  const payload = {
    session_id: 'test',
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: tool,
    tool_input: { file_path: join(dir, file) },
  }
  return spawnSync('node', [HOOK], {
    input: raw ?? JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  })
}

const statePath = (dir) => join(dir, '.claude', 'atlas', '.state.json')
const lockPath = (dir) => join(dir, '.claude', 'atlas', '.freshen.lock')
const readStateFile = (dir) => readFileSync(statePath(dir), 'utf8')

/** Leaves an indexable change on disk, so any refresh that runs is visible in the state. */
function pendingChange(dir) {
  writeFileSync(join(dir, NEW_FILE), 'export function formatDate() {}\n')
}

test('a repository with no index is left alone, silently', () => {
  const dir = stageFixture()
  const result = fire(dir)

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.ok(!existsSync(join(dir, '.claude')), 'a hook must not create an index nobody asked for')
})

test('an edit to an indexable file refreshes the index', () => {
  const dir = stageFixture()
  atlas(dir)
  pendingChange(dir)

  const result = fire(dir)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '', 'a successful refresh says nothing')
  assert.equal(result.stderr, '')

  const state = JSON.parse(readStateFile(dir))
  assert.ok(state.nodesByFile['packages/utils/src/date.ts'], 'the new file must be in the state')
  assert.ok(!existsSync(lockPath(dir)), 'the lock must be released')

  const utils = readFileSync(join(dir, '.claude', 'atlas', 'inventory', 'utils.md'), 'utf8')
  assert.match(utils, /`formatDate`/)
})

test('an edit to a file the extractor ignores does no work', () => {
  const dir = stageFixture()
  atlas(dir)
  pendingChange(dir)
  const before = readStateFile(dir)

  for (const file of ['README.md', join('apps', 'web', 'lib', 'invoice-total.test.ts')]) {
    const result = fire(dir, { file })
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    assert.equal(readStateFile(dir), before, `${file} must not trigger a refresh`)
  }
})

test('a malformed payload exits quietly', () => {
  const dir = stageFixture()
  atlas(dir)
  pendingChange(dir)
  const before = readStateFile(dir)

  for (const raw of ['', '   ', 'not json', '{"cwd":', '[]', 'null']) {
    const result = fire(dir, { raw })
    assert.equal(result.status, 0, `exit 0 on ${JSON.stringify(raw)}`)
    assert.equal(result.stderr, '', `no stack trace on ${JSON.stringify(raw)}`)
    assert.equal(readStateFile(dir), before)
  }
})

test('a held lock keeps a second run from doing work', () => {
  const dir = stageFixture()
  atlas(dir)
  pendingChange(dir)
  const before = readStateFile(dir)
  writeFileSync(lockPath(dir), '99999')

  const result = fire(dir)
  assert.equal(result.status, 0)
  assert.equal(readStateFile(dir), before, 'the second run must skip while the first holds the lock')
  assert.ok(existsSync(lockPath(dir)), 'a lock it never took is not its to release')
})

test('a stale lock is taken over', () => {
  const dir = stageFixture()
  atlas(dir)
  pendingChange(dir)
  writeFileSync(lockPath(dir), '99999')
  const longAgo = Date.now() / 1000 - 600
  utimesSync(lockPath(dir), longAgo, longAgo)

  const result = fire(dir)
  assert.equal(result.status, 0)

  const state = JSON.parse(readStateFile(dir))
  assert.ok(state.nodesByFile['packages/utils/src/date.ts'])
  assert.ok(!existsSync(lockPath(dir)))
})

test('a state written by another version is left for /atlas-init', () => {
  const dir = stageFixture()
  atlas(dir)
  const state = JSON.parse(readStateFile(dir))
  state.version = 999
  writeFileSync(statePath(dir), JSON.stringify(state, null, 2) + '\n')
  const before = readStateFile(dir)
  pendingChange(dir)

  const result = fire(dir)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(readStateFile(dir), before, 'a full re-extract is not a hook decision')
})
