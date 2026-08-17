import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'scripts', 'atlas.mjs')
const CONTEXT = join(here, '..', 'hooks', 'atlas-context.mjs')
const GATE = join(here, '..', 'hooks', 'atlas-gate.mjs')

function stageIndexed() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-gate-'))
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

function run(script, payload) {
  return execFileSync('node', [script], { input: JSON.stringify(payload), encoding: 'utf8' })
}

test('the context hook states the index and how to ask it', () => {
  const dir = stageIndexed()
  const out = run(CONTEXT, { cwd: dir, hook_event_name: 'UserPromptSubmit', user_prompt: 'add a helper' })
  assert.match(out, /Atlas index available/)
  assert.match(out, /Indexed at/)
  assert.match(out, /--find/)
  assert.match(out, /--rdeps/)
})

test('the context hook says nothing when the repository has no index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-gate-'))
  assert.equal(run(CONTEXT, { cwd: dir, user_prompt: 'hello' }), '')
})

test('the gate denies a new file that re-exports an existing name, with the locations', () => {
  const dir = stageIndexed()
  const out = run(GATE, {
    cwd: dir,
    session_id: 's1',
    tool_name: 'Write',
    tool_input: {
      file_path: join(dir, 'apps/web/lib/money.ts'),
      content: 'export function formatCurrency(cents: number) {\n  return String(cents)\n}\n',
    },
  })

  const decision = JSON.parse(out).hookSpecificOutput
  assert.equal(decision.permissionDecision, 'deny')
  assert.match(decision.permissionDecisionReason, /formatCurrency/)
  assert.match(decision.permissionDecisionReason, /packages\/utils\/src\/currency\.ts:2/)
})

test('the gate lets the same write through on a second attempt', () => {
  const dir = stageIndexed()
  const payload = {
    cwd: dir,
    session_id: 's1',
    tool_name: 'Write',
    tool_input: {
      file_path: join(dir, 'apps/web/lib/money.ts'),
      content: 'export function formatCurrency() {}\n',
    },
  }

  assert.match(run(GATE, payload), /deny/)
  assert.equal(run(GATE, payload), '', 'a deliberate retry must not hit a wall')
})

test('the gate stays out of the way for a genuinely new name', () => {
  const dir = stageIndexed()
  const out = run(GATE, {
    cwd: dir,
    session_id: 's1',
    tool_name: 'Write',
    tool_input: {
      file_path: join(dir, 'apps/web/lib/telemetry.ts'),
      content: 'export function recordPageView() {}\n',
    },
  })
  assert.equal(out, '')
})

test('the gate ignores short names, existing files, and non-code writes', () => {
  const dir = stageIndexed()
  const write = (file_path, content) =>
    run(GATE, { cwd: dir, session_id: 's2', tool_name: 'Write', tool_input: { file_path, content } })

  assert.equal(write(join(dir, 'apps/web/lib/ids.ts'), 'export const id = 1\n'), '')
  assert.equal(write(join(dir, 'notes.md'), '# formatCurrency\n'), '')

  writeFileSync(join(dir, 'apps/web/lib/existing.ts'), 'export function formatCurrency() {}\n')
  assert.equal(write(join(dir, 'apps/web/lib/existing.ts'), 'export function formatCurrency() {}\n'), '')
})

test('the gate allows the write when there is no index to consult', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-gate-'))
  const out = run(GATE, {
    cwd: dir,
    tool_name: 'Write',
    tool_input: { file_path: join(dir, 'a.ts'), content: 'export function formatCurrency() {}\n' },
  })
  assert.equal(out, '')
  assert.ok(!existsSync(join(dir, '.claude')))
})
