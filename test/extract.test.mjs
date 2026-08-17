import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractFile } from '../scripts/lib/extract.mjs'

test('extracts exported symbols from TypeScript', () => {
  const src = [
    'import { x } from "./x"',
    '',
    '/** Formats cents into a BRL string. */',
    'export function formatCurrency(cents: number): string {',
    '  return ""',
    '}',
    '',
    'export const TAX_RATE = 0.15',
    'const privateThing = 1',
    'export interface Invoice { id: string }',
  ].join('\n')

  const nodes = extractFile('packages/utils/src/currency.ts', src)
  const byName = Object.fromEntries(nodes.map((n) => [n.name, n]))

  assert.equal(nodes.length, 3)
  assert.equal(byName.formatCurrency.kind, 'function')
  assert.equal(byName.formatCurrency.line, 4)
  assert.equal(byName.formatCurrency.purpose, 'Formats cents into a BRL string.')
  assert.equal(byName.formatCurrency.id, 'function:packages/utils/src/currency.ts#formatCurrency')
  assert.equal(byName.TAX_RATE.kind, 'const')
  assert.equal(byName.TAX_RATE.purpose, '')
  assert.equal(byName.Invoice.kind, 'interface')
  assert.ok(!('privateThing' in byName))
})

test('reads the first content line of a multi-line JSDoc block', () => {
  const src = [
    '/**',
    ' * Formats cents into a BRL string.',
    ' * Rounds to the nearest cent first.',
    ' */',
    'export function formatCurrency() {}',
  ].join('\n')
  const [node] = extractFile('src/currency.ts', src)
  assert.equal(node.purpose, 'Formats cents into a BRL string.')
})

test('a multi-line JSDoc block with no content yields an empty purpose', () => {
  const src = ['/**', ' *', ' */', 'export function noop() {}'].join('\n')
  const [node] = extractFile('src/noop.ts', src)
  assert.equal(node.purpose, '')
})

test('reads a line comment as purpose', () => {
  const src = ['// Rounds up to the next cent.', 'export function roundCents(v: number) {}'].join('\n')
  const [node] = extractFile('src/round.ts', src)
  assert.equal(node.purpose, 'Rounds up to the next cent.')
})

test('extracts exported names from Python', () => {
  const src = ['import os', '', 'def allocate(items):', '    pass', '', 'def _internal():', '    pass'].join('\n')
  const nodes = extractFile('engine/engine.py', src)
  assert.deepEqual(nodes.map((n) => n.name), ['allocate'])
  assert.equal(nodes[0].kind, 'function')
})

test('Python class and def get distinct kinds', () => {
  const src = ['class Foo:', '    pass', '', 'def bar():', '    pass'].join('\n')
  const nodes = extractFile('engine/models.py', src)
  const byName = Object.fromEntries(nodes.map((n) => [n.name, n]))
  assert.equal(byName.Foo.kind, 'class')
  assert.equal(byName.bar.kind, 'function')
})

test('extracts a Next App Router route from its path', () => {
  const nodes = extractFile('apps/web/app/(dash)/reports/[id]/page.tsx', 'export default function Page() {}')
  const route = nodes.find((n) => n.kind === 'route')
  assert.equal(route.name, '/reports/[id]')
  assert.equal(route.id, 'route:apps/web/app/(dash)/reports/[id]/page.tsx#/reports/[id]')
})

test('extracts a route handler path with its methods', () => {
  const nodes = extractFile('apps/web/app/api/quotes/route.ts', 'export async function POST() {}')
  const route = nodes.find((n) => n.kind === 'route')
  assert.equal(route.name, '/api/quotes')
})

test('extracts a FastAPI route from a decorator', () => {
  const src = ['@router.post("/calc/run")', 'def run_calc():', '    pass'].join('\n')
  const route = extractFile('apps/calc-api/main.py', src).find((n) => n.kind === 'route')
  assert.equal(route.name, 'POST /calc/run')
  assert.equal(route.line, 1)
})

test('extracts tables from a SQL migration', () => {
  const src = ['create table if not exists public.properties (', '  id uuid primary key', ');'].join('\n')
  const nodes = extractFile('supabase/migrations/0001_init.sql', src)
  assert.deepEqual(nodes.map((n) => [n.kind, n.name]), [['table', 'properties']])
})

test('extracts a Drizzle table declaration', () => {
  const src = 'export const users = pgTable("users", {})'
  const nodes = extractFile('packages/db/schema.ts', src)
  assert.ok(nodes.some((n) => n.kind === 'table' && n.name === 'users'))
})

test('nextRoutePath anchors on rightmost app segment', () => {
  const nodes = extractFile('apps/app/app/foo/page.tsx', 'export default function Page() {}')
  const route = nodes.find((n) => n.kind === 'route')
  assert.equal(route.name, '/foo')
})

test('comment does not leak past blank line to next declaration', () => {
  const src = [
    'export function A() {}',
    '// TODO: revisit A someday',
    '',
    'export function B() {}',
  ].join('\n')
  const nodes = extractFile('src/misc.ts', src)
  const byName = Object.fromEntries(nodes.map((n) => [n.name, n]))
  assert.equal(byName.B.purpose, '')
})

test('a re-export is indexed under its published name, carrying the name it came from', () => {
  const src = 'export { PageScaffold as AdvisorPageScaffold } from "@/components/shared/page-scaffold"'
  const nodes = extractFile('apps/web/advisor/page-scaffold.ts', src)
  const node = nodes.find((n) => n.kind === 'reexport')

  assert.equal(node.name, 'AdvisorPageScaffold')
  assert.equal(node.source, 'PageScaffold')
  assert.equal(node.from, '@/components/shared/page-scaffold')
  assert.equal(node.line, 1)
})

test('a re-export without an alias keeps one name on both sides', () => {
  const nodes = extractFile('src/index.ts', 'export { formatMoney } from "./money"')
  const node = nodes.find((n) => n.kind === 'reexport')
  assert.equal(node.name, 'formatMoney')
  assert.equal(node.source, 'formatMoney')
})

test('one re-export line publishing several names yields one node each', () => {
  const nodes = extractFile('src/index.ts', 'export { a, b as c, type D } from "./x"')
  assert.deepEqual(
    nodes.filter((n) => n.kind === 'reexport').map((n) => `${n.source}->${n.name}`),
    ['a->a', 'b->c', 'D->D']
  )
})

test('a star re-export publishes no name, so it yields no node', () => {
  const nodes = extractFile('src/index.ts', 'export * from "./x"')
  assert.equal(nodes.filter((n) => n.kind === 'reexport').length, 0)
})

test('a type-only re-export is still a re-export', () => {
  const nodes = extractFile('src/index.ts', 'export type { Invoice } from "./types"')
  assert.equal(nodes.find((n) => n.kind === 'reexport')?.name, 'Invoice')
})

test('re-exports are a TypeScript idea and are not read out of Python', () => {
  const nodes = extractFile('src/x.py', 'export { a } from "./b"')
  assert.equal(nodes.filter((n) => n.kind === 'reexport').length, 0)
})
