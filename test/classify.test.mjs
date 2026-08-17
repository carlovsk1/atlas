import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bucketOf, areaOf, BUCKETS } from '../scripts/lib/classify.mjs'

const n = (over) => ({ id: 'x', kind: 'function', name: 'x', path: 'src/x.ts', line: 1, purpose: '', ...over })

test('routes and tables get their own buckets', () => {
  assert.equal(bucketOf(n({ kind: 'route' })), 'routes')
  assert.equal(bucketOf(n({ kind: 'table' })), 'data')
})

test('types land in data', () => {
  assert.equal(bucketOf(n({ kind: 'interface', name: 'Invoice' })), 'data')
  assert.equal(bucketOf(n({ kind: 'type', name: 'Money' })), 'data')
  assert.equal(bucketOf(n({ kind: 'enum', name: 'Status' })), 'data')
})

test('classes land in data', () => {
  assert.equal(bucketOf(n({ kind: 'class', name: 'HealthResponse' })), 'data')
})

test('use-prefixed names are hooks', () => {
  assert.equal(bucketOf(n({ name: 'useInvoice', path: 'src/hooks/useInvoice.ts' })), 'hooks')
  assert.equal(bucketOf(n({ name: 'user', path: 'src/user.ts' })), 'utils')
})

test('PascalCase in a tsx file is a component', () => {
  assert.equal(bucketOf(n({ name: 'InvoiceCard', path: 'src/InvoiceCard.tsx' })), 'components')
  assert.equal(bucketOf(n({ name: 'InvoiceCard', path: 'src/invoice.ts' })), 'utils')
})

test('everything else is a util', () => {
  assert.equal(bucketOf(n({ name: 'formatCurrency' })), 'utils')
})

test('areas come from the path', () => {
  assert.equal(areaOf('apps/web/components/Card.tsx'), 'apps/web')
  assert.equal(areaOf('packages/utils/src/currency.ts'), 'packages/utils')
  assert.equal(areaOf('engine/allocation.py'), 'engine')
  assert.equal(areaOf('supabase/migrations/0001.sql'), 'supabase')
  assert.equal(areaOf('lib/helpers.ts'), 'root')
})

test('config overrides win over heuristics', () => {
  const config = { areas: { 'engine/pricing': 'pricing' } }
  assert.equal(areaOf('engine/pricing/rules.py', config), 'pricing')
  assert.equal(areaOf('engine/other.py', config), 'engine')
})

test('buckets are in a stable order', () => {
  assert.deepEqual(BUCKETS, ['components', 'hooks', 'routes', 'data', 'utils'])
})
