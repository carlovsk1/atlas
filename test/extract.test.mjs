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
