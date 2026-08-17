import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'scripts', 'atlas.mjs')
const CONTEXT = join(here, '..', 'hooks', 'atlas-context.mjs')
const GATE = join(here, '..', 'hooks', 'atlas-gate.mjs')
const SEARCH = join(here, '..', 'hooks', 'atlas-search.mjs')

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

test('the context hook answers --find for a name the prompt mentions', () => {
  const dir = stageIndexed()
  const out = run(CONTEXT, { cwd: dir, prompt: 'add a formatCurrency helper to the web app' })
  assert.match(out, /formatCurrency: 1 match/)
  assert.match(out, /packages\/utils\/src\/currency\.ts:2/)
})

test('the context hook says a name is free rather than staying quiet about it', () => {
  const dir = stageIndexed()
  const out = run(CONTEXT, { cwd: dir, prompt: 'write a parseShippingLabel util' })
  assert.match(out, /parseShippingLabel: nothing in the index exports this/)
})

test('the context hook answers --rdeps for a path the prompt mentions', () => {
  const dir = stageIndexed()
  const out = run(CONTEXT, { cwd: dir, prompt: 'change packages/utils/src/currency.ts to take cents' })
  assert.match(out, /packages\/utils\/src\/currency\.ts is imported by/)
})

test('a prompt that names nothing costs what it did before', () => {
  const dir = stageIndexed()
  const out = run(CONTEXT, { cwd: dir, prompt: 'what did we decide about taxes last week?' })
  assert.match(out, /Atlas index available/)
  assert.doesNotMatch(out, /already looked up/)
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

test('the gate does not fight the framework a repository is written in', () => {
  const dir = stageIndexed()
  const route = join(dir, 'apps/web/app/api/invoices/route.ts')
  mkdirSync(dirname(route), { recursive: true })
  writeFileSync(route, 'export async function POST() {}\nexport const metadata = { title: "x" }\n')
  execFileSync('node', [CLI, '--repo', dir], { encoding: 'utf8' })

  const out = run(GATE, {
    cwd: dir,
    session_id: 's1',
    tool_name: 'Write',
    tool_input: {
      file_path: join(dir, 'apps/web/app/api/refunds/route.ts'),
      content: 'export async function POST() {}\nexport const metadata = { title: "y" }\n',
    },
  })

  assert.equal(out, '', 'every Next route handler exports POST; that is not a collision')
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

test('the search gate answers a Grep for an indexed name instead of running it', () => {
  const dir = stageIndexed()
  const out = run(SEARCH, {
    cwd: dir,
    session_id: 's1',
    tool_name: 'Grep',
    tool_input: { pattern: 'formatCurrency' },
  })

  const decision = JSON.parse(out).hookSpecificOutput
  assert.equal(decision.permissionDecision, 'deny')
  assert.match(decision.permissionDecisionReason, /packages\/utils\/src\/currency\.ts:2/)
})

test('the search gate answers a shell grep too, which is how the search is usually run', () => {
  const dir = stageIndexed()
  const out = run(SEARCH, {
    cwd: dir,
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'grep -rl "formatCurrency" packages/' },
  })

  assert.match(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, /currency\.ts:2/)
})

test('the search gate lets the same name through on a second attempt', () => {
  const dir = stageIndexed()
  const payload = {
    cwd: dir,
    session_id: 's1',
    tool_name: 'Grep',
    tool_input: { pattern: 'formatCurrency' },
  }

  assert.match(run(SEARCH, payload), /deny/)
  assert.equal(run(SEARCH, payload), '', 'wanting the raw matches anyway must not hit a wall')
})

test('the search gate stays out of content searches, which the index cannot answer', () => {
  const dir = stageIndexed()
  const search = (tool_name, tool_input) =>
    run(SEARCH, { cwd: dir, session_id: 's3', tool_name, tool_input })

  // A regex, a string literal, a path, a name nothing exports, a name too short to mean
  // anything. None of these is a question the graph holds an answer to.
  assert.equal(search('Grep', { pattern: 'export (async )?function' }), '')
  assert.equal(search('Grep', { pattern: 'rgba(10,13,18,0.05)' }), '')
  assert.equal(search('Grep', { pattern: 'parseShippingLabel' }), '')
  assert.equal(search('Grep', { pattern: 'id' }), '')
  assert.equal(search('Bash', { command: 'find . -name "page.tsx"' }), '')
  assert.equal(search('Bash', { command: 'npm test' }), '')
})

test('the search gate allows the search when there is no index to consult', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-gate-'))
  const out = run(SEARCH, {
    cwd: dir,
    tool_name: 'Grep',
    tool_input: { pattern: 'formatCurrency' },
  })
  assert.equal(out, '')
  assert.ok(!existsSync(join(dir, '.claude')))
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
