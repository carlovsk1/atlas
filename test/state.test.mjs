import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readState, writeState, planWork, STATE_VERSION } from '../scripts/lib/state.mjs'

const always = () => true

test('readState returns null when no state exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-state-'))
  assert.equal(readState(dir), null)
})

test('state round-trips through disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-state-'))
  const state = {
    version: STATE_VERSION,
    indexedAt: '2026-08-16T00:00:00.000Z',
    commit: 'abc',
    files: { 'src/a.ts': 'sha1' },
    nodesByFile: { 'src/a.ts': [] },
  }
  writeState(dir, state)
  assert.deepEqual(readState(dir), state)
})

test('a null previous state extracts everything indexable', () => {
  const files = new Map([['src/a.ts', 'sha1'], ['README.md', 'sha2']])
  const plan = planWork(null, files, new Set(), (p) => p.endsWith('.ts'))
  assert.deepEqual(plan.toExtract, ['src/a.ts'])
  assert.deepEqual(plan.unchanged, [])
  assert.deepEqual(plan.removed, [])
})

test('unchanged hashes are skipped', () => {
  const prev = { version: STATE_VERSION, indexedAt: '', commit: '', files: { 'src/a.ts': 'sha1' }, nodesByFile: {} }
  const files = new Map([['src/a.ts', 'sha1']])
  const plan = planWork(prev, files, new Set(), always)
  assert.deepEqual(plan.toExtract, [])
  assert.deepEqual(plan.unchanged, ['src/a.ts'])
})

test('changed hashes are re-extracted', () => {
  const prev = { version: STATE_VERSION, indexedAt: '', commit: '', files: { 'src/a.ts': 'sha1' }, nodesByFile: {} }
  const files = new Map([['src/a.ts', 'sha2']])
  assert.deepEqual(planWork(prev, files, new Set(), always).toExtract, ['src/a.ts'])
})

test('dirty files are always re-extracted even when the hash matches', () => {
  const prev = { version: STATE_VERSION, indexedAt: '', commit: '', files: { 'src/a.ts': 'sha1' }, nodesByFile: {} }
  const files = new Map([['src/a.ts', 'sha1']])
  const plan = planWork(prev, files, new Set(['src/a.ts']), always)
  assert.deepEqual(plan.toExtract, ['src/a.ts'])
})

test('files gone from the repo are reported as removed', () => {
  const prev = { version: STATE_VERSION, indexedAt: '', commit: '', files: { 'src/gone.ts': 'sha1' }, nodesByFile: {} }
  const plan = planWork(prev, new Map(), new Set(), always)
  assert.deepEqual(plan.removed, ['src/gone.ts'])
})

test('a state from an older version forces a full re-extract', () => {
  const prev = { version: 0, indexedAt: '', commit: '', files: { 'src/a.ts': 'sha1' }, nodesByFile: {} }
  const files = new Map([['src/a.ts', 'sha1']])
  assert.deepEqual(planWork(prev, files, new Set(), always).toExtract, ['src/a.ts'])
})

test('plan output is sorted', () => {
  const files = new Map([['src/z.ts', 's'], ['src/a.ts', 's']])
  assert.deepEqual(planWork(null, files, new Set(), always).toExtract, ['src/a.ts', 'src/z.ts'])
})

test('a path no longer matching indexable is reported as removed', () => {
  const prev = { version: STATE_VERSION, indexedAt: '', commit: '', files: { 'src/old.txt': 'sha1' }, nodesByFile: {} }
  const files = new Map([['src/old.txt', 'sha1']])
  const plan = planWork(prev, files, new Set(), (p) => p.endsWith('.ts'))
  assert.deepEqual(plan.toExtract, [])
  assert.deepEqual(plan.unchanged, [])
  assert.deepEqual(plan.removed, ['src/old.txt'])
})
