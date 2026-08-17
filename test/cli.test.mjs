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
  assert.match(out, /skipped 6/)
})

test('the graph carries import edges and drops specifiers that leave the repository', () => {
  const dir = stageFixture()
  atlas(dir)
  const graph = JSON.parse(readFileSync(join(dir, '.claude', 'atlas', 'graph.json'), 'utf8'))
  const imports = graph.edges.filter((e) => e.kind === 'imports')

  assert.ok(
    imports.some(
      (e) => e.from === 'file:apps/web/lib/invoice-total.ts' && e.to === 'file:packages/utils/src/currency.ts'
    ),
    'the tsconfig alias should resolve'
  )
  assert.ok(
    imports.some(
      (e) => e.from === 'file:apps/web/lib/invoice-total.ts' && e.to === 'file:apps/web/hooks/useInvoice.ts'
    ),
    'the relative import should resolve'
  )
  assert.equal(imports.length, 2, 'zod is not in this repository and must not become an edge')
  assert.ok(graph.nodes.some((n) => n.kind === 'file' && n.path === 'apps/web/lib/invoice-total.ts'))
})

test('--graph writes a self-contained viewer with the data inlined', () => {
  const dir = stageFixture()
  const out = atlas(dir, '--graph')
  const html = readFileSync(join(dir, '.claude', 'atlas', 'graph.html'), 'utf8')

  assert.match(out, /wrote .*graph\.html/)
  assert.ok(!html.includes('__ATLAS_GRAPH__'), 'the placeholder must be replaced')
  assert.ok(!/src\s*=\s*["']https?:/.test(html), 'the viewer must not reach for the network')
  // The key separator used to be a raw NUL byte sitting in the template. It is invisible
  // to anyone editing it, so new code typed a real space and every reverse lookup silently
  // missed. It is a named constant now, and no control character belongs in this file.
  assert.ok(
    !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(html),
    'the viewer must hold no invisible control characters'
  )
  assert.match(html, /apps\/web\/lib\/invoice-total\.ts/)

  const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'))
  assert.doesNotThrow(() => new Function(script), 'the inlined viewer must be syntactically valid')

  const data = JSON.parse(script.match(/const DATA = (\{.*?\});\n/s)[1])
  assert.equal(data.files.length, 6)
  assert.equal(data.edges.length, 2)
  assert.equal(data.root, dir, 'the viewer needs the absolute root to link into the editor')
})

test('the viewer is only written when asked for', () => {
  const dir = stageFixture()
  atlas(dir)
  assert.ok(!existsSync(join(dir, '.claude', 'atlas', 'graph.html')))
})

test('--find answers from the index instead of making the caller read it', () => {
  const dir = stageFixture()
  atlas(dir)
  const out = atlas(dir, '--find', 'formatCurrency')
  assert.match(out, /1 match/)
  assert.match(out, /formatCurrency\s+function\s+packages\/utils\/src\/currency\.ts:2/)
})

test('--deps and --rdeps walk the import graph in both directions', () => {
  const dir = stageFixture()
  atlas(dir)

  const deps = atlas(dir, '--deps', 'apps/web/lib/invoice-total.ts')
  assert.match(deps, /packages\/utils\/src\/currency\.ts/)
  assert.match(deps, /apps\/web\/hooks\/useInvoice\.ts/)

  const rdeps = atlas(dir, '--rdeps', 'packages/utils/src/currency.ts')
  assert.match(rdeps, /is imported by 1 file/)
  assert.match(rdeps, /apps\/web\/lib\/invoice-total\.ts/)
})

test('a query never rebuilds the index', () => {
  const dir = stageFixture()
  atlas(dir)
  const statePath = join(dir, '.claude', 'atlas', '.state.json')
  const before = readFileSync(statePath, 'utf8')
  atlas(dir, '--find', 'formatCurrency')
  atlas(dir, '--rdeps', 'packages/utils/src/currency.ts')
  assert.equal(readFileSync(statePath, 'utf8'), before)
})

test('--impact ranks the working tree by how many files import what changed', () => {
  const dir = stageFixture()
  atlas(dir)
  writeFileSync(join(dir, 'packages', 'utils', 'src', 'currency.ts'), 'export const TAX_RATE = 0.2\n')
  const out = atlas(dir, '--impact')
  assert.match(out, /1 changed file/)
  assert.match(out, /packages\/utils\/src\/currency\.ts\s+1 importer/)
})

test('a query without an index says how to build one', () => {
  const dir = stageFixture()
  let failure
  try {
    atlas(dir, '--find', 'anything')
  } catch (err) {
    failure = err
  }
  assert.ok(failure, 'querying without an index must exit non-zero')
  assert.match(String(failure.stderr), /Run \/atlas-init/)
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
