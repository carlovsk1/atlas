import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { duplicateNames } from '../scripts/lib/ledger.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'scripts', 'atlas.mjs')
const CONTEXT = join(here, '..', 'hooks', 'atlas-context.mjs')
const GATE = join(here, '..', 'hooks', 'atlas-gate.mjs')

function stageIndexed() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-report-'))
  cpSync(join(here, 'fixtures', 'sample-repo'), dir, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: dir })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
  execFileSync('node', [CLI, '--repo', dir], { encoding: 'utf8' })
  return dir
}

const atlas = (dir, ...args) => execFileSync('node', [CLI, '--repo', dir, ...args], { encoding: 'utf8' })
const hook = (script, payload) => execFileSync('node', [script], { input: JSON.stringify(payload), encoding: 'utf8' })
const ledger = (dir) => readFileSync(join(dir, '.claude', 'atlas', '.ledger.jsonl'), 'utf8').trim().split('\n')

test('a repository with no assists still reports its duplication', () => {
  const dir = stageIndexed()
  const out = atlas(dir, '--report')
  assert.match(out, /no assists recorded yet/)
  assert.match(out, /repo duplication {2}\d+ names exported from 2\+ files/)
})

test('a denied write is recorded as a prevented duplicate', () => {
  const dir = stageIndexed()
  hook(GATE, {
    cwd: dir,
    session_id: 's1',
    tool_name: 'Write',
    tool_input: {
      file_path: join(dir, 'apps/web/lib/money.ts'),
      content: 'export function formatCurrency() {}\n',
    },
  })

  const entry = JSON.parse(ledger(dir)[0])
  assert.equal(entry.kind, 'gate')
  assert.equal(entry.name, 'formatCurrency')
  assert.equal(entry.at, 'packages/utils/src/currency.ts:2')

  assert.match(atlas(dir, '--report'), /duplicates prevented {2,}1/)
})

test('a name the prompt hook answered is recorded, a name it did not find is not', () => {
  const dir = stageIndexed()
  hook(CONTEXT, { cwd: dir, session_id: 's1', prompt: 'add a formatCurrency helper' })
  hook(CONTEXT, { cwd: dir, session_id: 's2', prompt: 'write a parseShippingLabel util' })

  const entries = ledger(dir).map((line) => JSON.parse(line))
  assert.equal(entries.length, 1, 'a miss is not an assist')
  assert.equal(entries[0].kind, 'find')
  assert.equal(entries[0].name, 'formatCurrency')

  assert.match(atlas(dir, '--report'), /context delivered {2,}1/)
})

test('manual queries count, and a query that found nothing does not', () => {
  const dir = stageIndexed()
  atlas(dir, '--find', 'formatCurrency')
  atlas(dir, '--find', 'nothingHereAtAll')
  atlas(dir, '--rdeps', 'packages/utils/src/currency.ts')

  const kinds = ledger(dir).map((line) => JSON.parse(line).kind)
  assert.deepEqual(kinds, ['find', 'rdeps'])
})

test('the report counts sessions, days, and the names asked for twice', () => {
  const dir = stageIndexed()
  hook(CONTEXT, { cwd: dir, session_id: 's1', prompt: 'add a formatCurrency helper' })
  hook(CONTEXT, { cwd: dir, session_id: 's2', prompt: 'reuse formatCurrency in the report' })

  const out = atlas(dir, '--report')
  assert.match(out, /1 day · 2 sessions/)
  assert.match(out, /most re-invented/)
  assert.match(out, /formatCurrency\s+2x\s+packages\/utils\/src\/currency\.ts:2/)
})

test('a torn ledger line costs itself and nothing else', () => {
  const dir = stageIndexed()
  atlas(dir, '--find', 'formatCurrency')
  const file = join(dir, '.claude', 'atlas', '.ledger.jsonl')
  execFileSync('sh', ['-c', `printf '{"kind":"gate"\\n' >> "${file}"`])
  atlas(dir, '--find', 'useInvoice')

  assert.match(atlas(dir, '--report'), /context delivered {2,}2/)
})

test('names a framework makes you repeat are not duplication', () => {
  const graph = {
    symbols: [
      { name: 'POST', kind: 'function', path: 'app/api/a/route.ts' },
      { name: 'POST', kind: 'function', path: 'app/api/b/route.ts' },
      { name: 'metadata', kind: 'const', path: 'app/a/page.tsx' },
      { name: 'metadata', kind: 'const', path: 'app/b/page.tsx' },
      { name: 'id', kind: 'const', path: 'a.ts' },
      { name: 'id', kind: 'const', path: 'b.ts' },
      { name: 'formatCurrency', kind: 'function', path: 'a.ts' },
      { name: 'formatCurrency', kind: 'function', path: 'b.ts' },
    ],
  }
  assert.equal(duplicateNames(graph), 1, 'only the name someone actually chose counts')
})

test('the ledger is never the reason a query fails', () => {
  const dir = stageIndexed()
  const out = atlas(dir, '--impact')
  assert.ok(existsSync(join(dir, '.claude', 'atlas', '.ledger.jsonl')))
  assert.match(out, /no indexable file changed|changed file/)
})
