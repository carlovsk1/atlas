import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, execFileSync as run } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'scripts', 'atlas.mjs')

function stageFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-cli-'))
  cpSync(join(here, 'fixtures', 'sample-repo'), dir, { recursive: true })
  const git = (...args) => run('git', args, { cwd: dir })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
  return dir
}

function atlas(dir, ...args) {
  return execFileSync('node', [CLI, '--repo', dir, ...args], { encoding: 'utf8' })
}

test('a full run writes the index, inventory, state, and graph', () => {
  const dir = stageFixture()
  atlas(dir)
  const atlasDir = join(dir, '.claude', 'atlas')

  assert.ok(existsSync(join(atlasDir, 'INDEX.md')))
  assert.ok(existsSync(join(atlasDir, 'inventory', 'components.md')))
  assert.ok(existsSync(join(atlasDir, 'inventory', 'data.md')))
  assert.ok(existsSync(join(atlasDir, '.state.json')))
  assert.ok(existsSync(join(atlasDir, 'graph.json')))

  const components = readFileSync(join(atlasDir, 'inventory', 'components.md'), 'utf8')
  assert.match(components, /`InvoiceCard`/)
  assert.match(components, /apps\/web\/components\/InvoiceCard\.tsx:1/)

  const hooks = readFileSync(join(atlasDir, 'inventory', 'hooks.md'), 'utf8')
  assert.match(hooks, /`useInvoice`/)

  const routes = readFileSync(join(atlasDir, 'inventory', 'routes.md'), 'utf8')
  assert.match(routes, /`\/reports\/\[id\]`/)

  const data = readFileSync(join(atlasDir, 'inventory', 'data.md'), 'utf8')
  assert.match(data, /`properties`/)

  const utils = readFileSync(join(atlasDir, 'inventory', 'utils.md'), 'utf8')
  assert.match(utils, /Formats cents into a BRL string\./)
})

test('running twice produces byte-identical output', () => {
  const dir = stageFixture()
  atlas(dir)
  const first = readFileSync(join(dir, '.claude', 'atlas', 'INDEX.md'), 'utf8')
  atlas(dir)
  const second = readFileSync(join(dir, '.claude', 'atlas', 'INDEX.md'), 'utf8')
  assert.equal(first, second)
})

test('update reports how many files it skipped', () => {
  const dir = stageFixture()
  atlas(dir)
  const out = atlas(dir, '--update')
  assert.match(out, /extracted 0/)
  assert.match(out, /skipped 5/)
})

test('update picks up a new symbol', () => {
  const dir = stageFixture()
  atlas(dir)
  writeFileSync(join(dir, 'packages', 'utils', 'src', 'date.ts'), 'export function formatDate() {}\n')
  const out = atlas(dir, '--update')
  assert.match(out, /extracted 1/)
  const utils = readFileSync(join(dir, '.claude', 'atlas', 'inventory', 'utils.md'), 'utf8')
  assert.match(utils, /`formatDate`/)
})

test('update drops a deleted file from the inventory', () => {
  const dir = stageFixture()
  atlas(dir)
  run('git', ['rm', '-q', 'apps/web/hooks/useInvoice.ts'], { cwd: dir })
  atlas(dir, '--update')
  const hooks = readFileSync(join(dir, '.claude', 'atlas', 'inventory', 'hooks.md'), 'utf8')
  assert.ok(!hooks.includes('useInvoice'))
})

test('indexes a repository that has no commits yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-cli-'))
  cpSync(join(here, 'fixtures', 'sample-repo'), dir, { recursive: true })
  const git = (...args) => run('git', args, { cwd: dir })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')

  atlas(dir)

  const index = readFileSync(join(dir, '.claude', 'atlas', 'INDEX.md'), 'utf8')
  assert.match(index, /Indexed at `uncommitted`/)
  const state = JSON.parse(readFileSync(join(dir, '.claude', 'atlas', '.state.json'), 'utf8'))
  assert.equal(state.commit, null)
  const components = readFileSync(join(dir, '.claude', 'atlas', 'inventory', 'components.md'), 'utf8')
  assert.match(components, /`InvoiceCard`/)
})
