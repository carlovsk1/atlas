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

test('inventory escapes pipe characters in purpose', () => {
  const nodeWithPipe = { id: 'test:pipe', kind: 'const', name: 'PIPE', path: 'apps/web/a.ts', line: 1, purpose: 'Value is A | B' }
  const md = renderInventory('utils', [nodeWithPipe])
  assert.match(md, /\| `PIPE` \| const \| `apps\/web\/a\.ts:1` \| Value is A \\| B \|/)
  assert.ok(md.includes('Value is A \\|'), 'pipe should be escaped as \\|')
})

test('inventory converts newlines in purpose to spaces', () => {
  const nodeWithNewline = { id: 'test:newline', kind: 'const', name: 'MULTI', path: 'apps/web/b.ts', line: 2, purpose: 'Line 1\nLine 2' }
  const md = renderInventory('utils', [nodeWithNewline])
  assert.match(md, /\| `MULTI` \| const \| `apps\/web\/b\.ts:2` \| Line 1 Line 2 \|/)
  const dataRows = md.split('\n').filter(l => l.startsWith('|') && !l.includes('---') && !l.includes('Symbol'))
  for (const row of dataRows) {
    assert.ok(!row.includes('\n'), 'no table row should contain a newline')
  }
})

test('renderIndex with all-zero counts and empty arrays produces valid markdown', () => {
  const md = renderIndex({
    commit: 'abc123',
    date: '2026-08-17',
    counts: { components: 0, hooks: 0, routes: 0, data: 0, utils: 0 },
    areas: [],
    patterns: [],
    decisions: [],
  })
  assert.match(md, /^# Atlas Index\n/)
  assert.match(md, /Indexed at `abc123`/)
  assert.ok(md.includes('No entries found') === false, 'should not reference inventory files')
})

test('inventory renders identically for two nodes sharing path and line, regardless of input order', () => {
  const shared = [
    { id: 'first-id', kind: 'const', name: 'A', path: 'apps/web/shared.ts', line: 5, purpose: 'First' },
    { id: 'second-id', kind: 'const', name: 'B', path: 'apps/web/shared.ts', line: 5, purpose: 'Second' },
  ]
  const md1 = renderInventory('utils', shared)
  const md2 = renderInventory('utils', [...shared].reverse())
  assert.equal(md1, md2, 'output should be byte-identical regardless of input order')
})

test('graph edges with a colliding `to` sort deterministically', () => {
  const dupA = { id: 'symbol:dup', kind: 'function', name: 'dup', path: 'apps/web/a.ts', line: 1, purpose: '' }
  const dupB = { id: 'symbol:dup', kind: 'function', name: 'dup', path: 'packages/utils/b.ts', line: 1, purpose: '' }
  const forward = buildGraph([dupA, dupB])
  const reverse = buildGraph([dupB, dupA])
  assert.deepEqual(forward.edges, reverse.edges)
  assert.equal(forward.edges.length, 2)
  assert.equal(forward.edges[0].to, forward.edges[1].to)
  assert.notEqual(forward.edges[0].from, forward.edges[1].from)
})
