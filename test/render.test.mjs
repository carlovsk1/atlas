import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderInventory, renderIndex, buildGraph } from '../scripts/lib/render.mjs'

const nodes = [
  { id: 'function:packages/utils/src/currency.ts#formatCurrency', kind: 'function', name: 'formatCurrency', path: 'packages/utils/src/currency.ts', line: 12, purpose: 'Formats cents into a BRL string.' },
  { id: 'const:apps/web/lib/tax.ts#TAX_RATE', kind: 'const', name: 'TAX_RATE', path: 'apps/web/lib/tax.ts', line: 3, purpose: '' },
]

test('inventory renders one table row per node with a clickable location', () => {
  const md = renderInventory('utils', nodes)
  assert.match(md, /^# Utils\n/)
  assert.match(md, /\| `formatCurrency` \| function \| `packages\/utils\/src\/currency\.ts:12` \| Formats cents into a BRL string\. \|/)
  assert.match(md, /\| `TAX_RATE` \| const \| `apps\/web\/lib\/tax\.ts:3` \|\s+\|/)
})

test('inventory groups by area and sorts deterministically', () => {
  const md = renderInventory('utils', [...nodes].reverse())
  const areaOrder = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1])
  assert.deepEqual(areaOrder, ['apps/web', 'packages/utils'])
})

test('inventory renders the same output regardless of input order', () => {
  assert.equal(renderInventory('utils', nodes), renderInventory('utils', [...nodes].reverse()))
})

test('an empty bucket still renders a valid file', () => {
  const md = renderInventory('hooks', [])
  assert.match(md, /^# Hooks\n/)
  assert.match(md, /No entries found/)
})

test('index reports the indexed commit and links every bucket', () => {
  const md = renderIndex({
    commit: 'a1b2c3d',
    date: '2026-08-16',
    counts: { components: 42, hooks: 0, routes: 7, data: 18, utils: 31 },
    areas: ['apps/web', 'packages/utils'],
    patterns: ['form-handling'],
    decisions: ['supabase-over-custom-backend'],
  })
  assert.match(md, /Indexed at `a1b2c3d` on 2026-08-16/)
  assert.match(md, /\[Components\]\(inventory\/components\.md\) — 42 entries/)
  assert.ok(!md.includes('inventory/hooks.md'), 'empty buckets are not linked')
  assert.match(md, /\[form-handling\]\(patterns\/form-handling\.md\)/)
  assert.match(md, /\[supabase-over-custom-backend\]\(decisions\/supabase-over-custom-backend\.md\)/)
})

test('graph has one node per symbol and a contains edge from its area', () => {
  const graph = buildGraph(nodes)
  assert.equal(graph.nodes.filter((n) => n.kind === 'area').length, 2)
  assert.ok(graph.nodes.some((n) => n.id === 'function:packages/utils/src/currency.ts#formatCurrency'))
  assert.ok(graph.edges.some((e) => e.kind === 'contains' && e.from === 'area:packages/utils' && e.to === nodes[0].id))
})

test('graph output is sorted by id', () => {
  const ids = buildGraph([...nodes].reverse()).nodes.map((n) => n.id)
  assert.deepEqual(ids, [...ids].sort())
})
