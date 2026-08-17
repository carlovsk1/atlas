import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listFiles, dirtyFiles, headSha } from '../scripts/lib/git.mjs'

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-git-'))
  const run = (...args) => execFileSync('git', args, { cwd: dir })
  run('init', '-q')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'Test')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 2\n')
  run('add', '-A')
  run('commit', '-q', '-m', 'init')
  return { dir }
}

test('listFiles returns tracked paths with blob hashes', () => {
  const { dir } = makeRepo()
  const files = listFiles(dir)
  assert.equal(files.size, 2)
  assert.ok(files.has('src/a.ts'))
  assert.match(files.get('src/a.ts'), /^[0-9a-f]{40}$/)
  assert.notEqual(files.get('src/a.ts'), files.get('src/b.ts'))
})

test('listFiles includes untracked files with an untracked marker', () => {
  const { dir } = makeRepo()
  writeFileSync(join(dir, 'src', 'c.ts'), 'export const c = 3\n')
  const files = listFiles(dir)
  assert.equal(files.get('src/c.ts'), 'untracked')
  assert.match(files.get('src/a.ts'), /^[0-9a-f]{40}$/)
})

test('dirtyFiles reports modified and untracked paths', () => {
  const { dir } = makeRepo()
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 99\n')
  writeFileSync(join(dir, 'src', 'c.ts'), 'export const c = 3\n')
  const dirty = dirtyFiles(dir)
  assert.ok(dirty.has('src/a.ts'))
  assert.ok(dirty.has('src/c.ts'))
  assert.ok(!dirty.has('src/b.ts'))
})

test('headSha returns the current commit', () => {
  const { dir } = makeRepo()
  assert.match(headSha(dir), /^[0-9a-f]{40}$/)
})
