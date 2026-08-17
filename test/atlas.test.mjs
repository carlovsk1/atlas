import { test } from 'node:test'
import assert from 'node:assert/strict'
import { indexable } from '../scripts/atlas.mjs'

test('indexable excludes files under a test directory', () => {
  assert.equal(indexable('test/extract.test.mjs'), false)
  assert.equal(indexable('packages/utils/test/helpers.ts'), false)
})

test('indexable excludes .test. and .spec. filenames', () => {
  assert.equal(indexable('foo.test.ts'), false)
  assert.equal(indexable('src/bar.spec.tsx'), false)
})

test('indexable still accepts ordinary source files', () => {
  assert.equal(indexable('src/currency.ts'), true)
})
