import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadGraph, findSymbol, dependencies, dependents, unreached, formatSymbols, formatWalk, formatUnreached } from '../scripts/lib/query.mjs'

const fileNode = (path, area = 'src') => ({
  id: `file:${path}`,
  kind: 'file',
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  area,
  symbols: 0,
})

const symbolNode = (name, path, line, kind = 'function', area = 'src') => ({
  id: `${kind}:${path}#${name}`,
  kind,
  name,
  path,
  line,
  area,
})

const importEdge = (from, to) => ({ from: `file:${from}`, to: `file:${to}`, kind: 'imports' })

function atlasDirWith(graph) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-query-'))
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(graph))
  return dir
}

function graphFrom({ nodes = [], edges = [] }) {
  return loadGraph(atlasDirWith({ nodes, edges }))
}

/** a imports b, b imports c, plus an unrelated d importing b. */
function chainGraph() {
  return graphFrom({
    nodes: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'].map((p) => fileNode(p)),
    edges: [
      importEdge('src/d.ts', 'src/b.ts'),
      importEdge('src/a.ts', 'src/b.ts'),
      importEdge('src/b.ts', 'src/c.ts'),
    ],
  })
}

test('loadGraph fails with an actionable message when there is no index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-query-'))
  assert.throws(() => loadGraph(dir), /cannot read .*graph\.json.*\/atlas-init/s)
})

test('loadGraph rejects a file that is not an Atlas graph', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-query-'))
  writeFileSync(join(dir, 'graph.json'), JSON.stringify({ hello: 'world' }))
  assert.throws(() => loadGraph(dir), /is not an Atlas graph/)
})

test('loadGraph separates symbols from files and keeps area nodes out', () => {
  const graph = graphFrom({
    nodes: [
      { id: 'area:src', kind: 'area', name: 'src' },
      fileNode('src/money.ts'),
      symbolNode('formatMoney', 'src/money.ts', 12),
    ],
  })
  assert.equal(graph.symbols.length, 1)
  assert.ok(graph.files.has('src/money.ts'))
})

test('an exact name match ranks above a substring match', () => {
  const graph = graphFrom({
    nodes: [
      symbolNode('formatMoneyShort', 'src/a.ts', 1),
      symbolNode('unformatMoney', 'src/b.ts', 2),
      symbolNode('formatMoney', 'src/z.ts', 99),
    ],
  })

  const matches = findSymbol(graph, 'formatMoney')
  assert.deepEqual(
    matches.map((m) => m.name),
    ['formatMoney', 'formatMoneyShort', 'unformatMoney']
  )
  assert.deepEqual(matches[0], { name: 'formatMoney', kind: 'function', path: 'src/z.ts', line: 99, area: 'src' })
})

test('matches sort by path then line, so output is stable across runs', () => {
  const nodes = [
    symbolNode('parseB', 'src/b.ts', 5),
    symbolNode('parseA', 'src/a.ts', 20),
    symbolNode('parseAA', 'src/a.ts', 3),
  ]
  const forward = findSymbol(graphFrom({ nodes }), 'parse')
  const reverse = findSymbol(graphFrom({ nodes: [...nodes].reverse() }), 'parse')
  assert.deepEqual(forward.map((m) => m.name), ['parseAA', 'parseA', 'parseB'])
  assert.deepEqual(forward, reverse)
})

test('substring matching is case-insensitive', () => {
  const graph = graphFrom({ nodes: [symbolNode('FormatMoney', 'src/a.ts', 1)] })
  assert.equal(findSymbol(graph, 'formatmoney').length, 1)
})

test('a symbol that does not exist yields no matches and says so', () => {
  const graph = graphFrom({ nodes: [symbolNode('formatMoney', 'src/a.ts', 1)] })
  const matches = findSymbol(graph, 'formatDate')
  assert.equal(matches.length, 0)
  assert.equal(matches.total, 0)
  assert.equal(formatSymbols(matches), 'atlas: no symbol matched')
})

test('direct dependents are the files that import the target', () => {
  const results = dependents(chainGraph(), 'src/b.ts')
  assert.deepEqual(results, [
    { path: 'src/a.ts', depth: 1, via: 'src/b.ts' },
    { path: 'src/d.ts', depth: 1, via: 'src/b.ts' },
  ])
})

test('dependents at depth 2 reach the second ring and record the hop', () => {
  const results = dependents(chainGraph(), 'src/c.ts', { depth: 2 })
  assert.deepEqual(results, [
    { path: 'src/b.ts', depth: 1, via: 'src/c.ts' },
    { path: 'src/a.ts', depth: 2, via: 'src/b.ts' },
    { path: 'src/d.ts', depth: 2, via: 'src/b.ts' },
  ])
})

test('depth 1 never reaches past the direct ring', () => {
  assert.deepEqual(
    dependents(chainGraph(), 'src/c.ts').map((r) => r.path),
    ['src/b.ts']
  )
})

test('dependencies walk the other direction', () => {
  const results = dependencies(chainGraph(), 'src/a.ts', { depth: 2 })
  assert.deepEqual(results, [
    { path: 'src/b.ts', depth: 1, via: 'src/a.ts' },
    { path: 'src/c.ts', depth: 2, via: 'src/b.ts' },
  ])
})

test('a cycle terminates and never re-emits the starting file', () => {
  const graph = graphFrom({
    nodes: ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((p) => fileNode(p)),
    edges: [
      importEdge('src/a.ts', 'src/b.ts'),
      importEdge('src/b.ts', 'src/c.ts'),
      importEdge('src/c.ts', 'src/a.ts'),
    ],
  })

  const results = dependencies(graph, 'src/a.ts', { depth: 10 })
  assert.deepEqual(results, [
    { path: 'src/b.ts', depth: 1, via: 'src/a.ts' },
    { path: 'src/c.ts', depth: 2, via: 'src/b.ts' },
  ])
})

test('an unknown path is flagged rather than reported as an empty result', () => {
  const graph = chainGraph()
  for (const walk of [dependents(graph, 'src/nope.ts'), dependencies(graph, 'src/nope.ts')]) {
    assert.equal(walk.length, 0)
    assert.equal(walk.unknown, true)
  }
  assert.match(formatWalk('src/nope.ts', dependents(graph, 'src/nope.ts'), 'dependents'), /is not an indexed file/)
})

test('a file with no edges is known and simply reaches nothing', () => {
  const graph = graphFrom({ nodes: [fileNode('src/lonely.ts')] })
  const results = dependents(graph, 'src/lonely.ts')
  assert.equal(results.length, 0)
  assert.equal(results.unknown, undefined)
  assert.match(formatWalk('src/lonely.ts', results, 'dependents'), /^src\/lonely\.ts is imported by 0 files$/)
})

test('formatSymbols prints one line per match under a count header', () => {
  const graph = graphFrom({
    nodes: [
      symbolNode('formatMoney', 'packages/web/src/lib/money.ts', 12, 'function', 'packages/web'),
      symbolNode('formatMoneyCents', 'packages/web/src/lib/money.ts', 30, 'const', 'packages/web'),
    ],
  })

  assert.equal(
    formatSymbols(findSymbol(graph, 'formatMoney')),
    [
      '2 matches',
      'formatMoney  function  packages/web/src/lib/money.ts:12  packages/web',
      'formatMoneyCents  const  packages/web/src/lib/money.ts:30  packages/web',
    ].join('\n')
  )
})

test('formatSymbols states how many results it dropped', () => {
  const nodes = Array.from({ length: 25 }, (_, i) => symbolNode(`formatMoney${i}`, `src/f${String(i).padStart(2, '0')}.ts`, 1))
  const out = formatSymbols(findSymbol(graphFrom({ nodes }), 'formatMoney', { limit: 100 }))
  const lines = out.split('\n')

  assert.equal(lines[0], '25 matches')
  assert.equal(lines.length, 22)
  assert.equal(lines.at(-1), '... 5 more omitted, cap 20')
})

test('findSymbol reports the pre-limit total so nothing truncates silently', () => {
  const nodes = Array.from({ length: 8 }, (_, i) => symbolNode(`formatMoney${i}`, `src/f${i}.ts`, 1))
  const matches = findSymbol(graphFrom({ nodes }), 'formatMoney', { limit: 3 })
  assert.equal(matches.length, 3)
  assert.equal(matches.total, 8)
  assert.match(formatSymbols(matches), /^8 matches\n[\s\S]*\.\.\. 5 more omitted/)
})

test('formatWalk labels the direction and marks hops past the first ring', () => {
  assert.equal(
    formatWalk('src/c.ts', dependents(chainGraph(), 'src/c.ts', { depth: 2 }), 'dependents'),
    ['src/c.ts is imported by 3 files', 'src/b.ts  d1', 'src/a.ts  d2 via src/b.ts', 'src/d.ts  d2 via src/b.ts'].join('\n')
  )

  assert.match(
    formatWalk('src/a.ts', dependencies(chainGraph(), 'src/a.ts'), 'dependencies'),
    /^src\/a\.ts imports 1 file\n/
  )
})

test('formatWalk states how many results it dropped', () => {
  const importers = Array.from({ length: 23 }, (_, i) => `src/i${String(i).padStart(2, '0')}.ts`)
  const graph = graphFrom({
    nodes: [fileNode('src/target.ts'), ...importers.map((p) => fileNode(p))],
    edges: importers.map((p) => importEdge(p, 'src/target.ts')),
  })

  const lines = formatWalk('src/target.ts', dependents(graph, 'src/target.ts'), 'dependents').split('\n')
  assert.equal(lines[0], 'src/target.ts is imported by 23 files')
  assert.equal(lines.length, 22)
  assert.equal(lines.at(-1), '... 3 more omitted, cap 20')
})

const reexportNode = (name, source, path, line, area = 'src') => ({
  id: `reexport:${path}#${name}`,
  kind: 'reexport',
  name,
  source,
  from: './somewhere',
  path,
  line,
  area,
})

test('a search for the original name also finds the alias a re-export publishes', () => {
  const graph = graphFrom({
    nodes: [
      symbolNode('PageScaffold', 'src/shared/page-scaffold.tsx', 40),
      reexportNode('AdvisorPageScaffold', 'PageScaffold', 'src/advisor/page-scaffold.tsx', 5),
    ],
  })

  const matches = findSymbol(graph, 'PageScaffold')
  assert.deepEqual(matches.map((m) => m.name), ['PageScaffold', 'AdvisorPageScaffold'])
  assert.equal(matches[1].source, 'PageScaffold')
})

test('the declaration outranks the alias, so the real implementation is line one', () => {
  const graph = graphFrom({
    nodes: [
      reexportNode('AliasA', 'formatMoney', 'src/a.ts', 1),
      symbolNode('formatMoney', 'src/z.ts', 99),
    ],
  })
  assert.equal(findSymbol(graph, 'formatMoney')[0].path, 'src/z.ts')
})

test('formatSymbols names what a re-export re-exports', () => {
  const graph = graphFrom({
    nodes: [reexportNode('AdvisorPageScaffold', 'PageScaffold', 'src/advisor/page-scaffold.tsx', 5)],
  })
  assert.match(
    formatSymbols(findSymbol(graph, 'AdvisorPageScaffold')),
    /^AdvisorPageScaffold {2}reexport of PageScaffold {2}src\/advisor\/page-scaffold\.tsx:5/m
  )
})

test('one name declared in two files is reported as a fork under the list', () => {
  const graph = graphFrom({
    nodes: [
      symbolNode('PageHeader', 'src/advisor/page-header.tsx', 27),
      symbolNode('PageHeader', 'src/shared/page-header.tsx', 41),
      symbolNode('FormPageHeader', 'src/form/chrome.tsx', 60),
    ],
  })

  const matches = findSymbol(graph, 'PageHeader')
  assert.deepEqual(matches.forks, [
    { name: 'PageHeader', paths: ['src/advisor/page-header.tsx', 'src/shared/page-header.tsx'] },
  ])

  const out = formatSymbols(matches)
  assert.match(out, /PageHeader is declared in 2 files, likely a fork:/)
  assert.match(out, /\n {2}src\/shared\/page-header\.tsx$/)
})

test('a re-export is never a fork: it is one implementation under a second name', () => {
  const graph = graphFrom({
    nodes: [
      symbolNode('formatMoney', 'src/money.ts', 1),
      reexportNode('formatMoney', 'formatMoney', 'src/index.ts', 2),
    ],
  })
  assert.deepEqual(findSymbol(graph, 'formatMoney').forks, [])
})

test('forks are counted over every match, not only the ones that fit the cap', () => {
  const filler = Array.from({ length: 25 }, (_, i) =>
    symbolNode(`parseThing${String(i).padStart(2, '0')}`, `src/a${String(i).padStart(2, '0')}.ts`, 1)
  )
  const graph = graphFrom({
    nodes: [...filler, symbolNode('parseThing', 'src/y.ts', 1), symbolNode('parseThing', 'src/z.ts', 1)],
  })
  assert.deepEqual(findSymbol(graph, 'parseThing').forks, [
    { name: 'parseThing', paths: ['src/y.ts', 'src/z.ts'] },
  ])
})

/** page -> view -> shell, plus a page that renders nothing shared. */
function adoptionGraph() {
  return graphFrom({
    nodes: [
      fileNode('src/shared/shell.tsx'),
      fileNode('src/app/good/page.tsx'),
      fileNode('src/app/good/view.tsx'),
      fileNode('src/app/bad/page.tsx'),
      fileNode('src/app/bad/table.tsx'),
      fileNode('src/other/page.tsx'),
      { id: 'route:src/app/good/page.tsx#/good', kind: 'route', name: '/good', path: 'src/app/good/page.tsx', line: 1, area: 'src' },
      { id: 'route:src/app/bad/page.tsx#/bad', kind: 'route', name: '/bad', path: 'src/app/bad/page.tsx', line: 1, area: 'src' },
    ],
    edges: [
      importEdge('src/app/good/page.tsx', 'src/app/good/view.tsx'),
      importEdge('src/app/good/view.tsx', 'src/shared/shell.tsx'),
      importEdge('src/app/bad/page.tsx', 'src/app/bad/table.tsx'),
    ],
  })
}

test('unreached names the files in scope that never reach the target', () => {
  const gaps = unreached(adoptionGraph(), 'src/shared/shell.tsx', { under: 'src/app/' })
  assert.deepEqual(gaps.map((g) => g.path), [
    'src/app/bad/page.tsx',
    'src/app/bad/table.tsx',
  ])
  assert.equal(gaps.scoped, 4)
})

test('unreached puts route files first, because the pages are the answer', () => {
  const gaps = unreached(adoptionGraph(), 'src/shared/shell.tsx', { under: 'src/' })
  assert.equal(gaps[0].path, 'src/app/bad/page.tsx')
  assert.equal(gaps[0].route, '/bad')
  assert.equal(gaps.at(-1).route, null)
})

test('depth 1 reports a page that reaches the target through a view as a gap', () => {
  const gaps = unreached(adoptionGraph(), 'src/shared/shell.tsx', { under: 'src/app/', depth: 1 })
  assert.ok(gaps.some((g) => g.path === 'src/app/good/page.tsx'))
})

test('the default depth follows the page through the view it renders', () => {
  const gaps = unreached(adoptionGraph(), 'src/shared/shell.tsx', { under: 'src/app/good' })
  assert.deepEqual(gaps.map((g) => g.path), [])
  assert.equal(gaps.scoped, 2)
})

test('the scope never counts the target as a file that failed to reach itself', () => {
  const gaps = unreached(adoptionGraph(), 'src/shared/shell.tsx', { under: 'src/shared' })
  assert.equal(gaps.scoped, 0)
  assert.equal(gaps.length, 0)
})

test('an unknown target is flagged rather than reported as total non-adoption', () => {
  const gaps = unreached(adoptionGraph(), 'src/nope.tsx', { under: 'src/' })
  assert.equal(gaps.unknown, true)
  assert.match(formatUnreached('src/nope.tsx', gaps, 'src/', 3), /is not an indexed file/)
})

test('formatUnreached distinguishes full adoption from an empty scope', () => {
  const graph = adoptionGraph()
  assert.match(
    formatUnreached('src/shared/shell.tsx', unreached(graph, 'src/shared/shell.tsx', { under: 'src/app/good' }), 'src/app/good', 3),
    /^all 2 files under `src\/app\/good` reach .* within 3 hops$/
  )
  assert.match(
    formatUnreached('src/shared/shell.tsx', unreached(graph, 'src/shared/shell.tsx', { under: 'nowhere' }), 'nowhere', 3),
    /^atlas: no indexed file has a path containing `nowhere`$/
  )
})

test('formatUnreached leads with the ratio and marks the routes', () => {
  const gaps = unreached(adoptionGraph(), 'src/shared/shell.tsx', { under: 'src/app/' })
  assert.deepEqual(formatUnreached('src/shared/shell.tsx', gaps, 'src/app/', 3).split('\n'), [
    '2 of 4 files under `src/app/` never reach src/shared/shell.tsx within 3 hops, 1 of them routes',
    'src/app/bad/page.tsx  route /bad',
    'src/app/bad/table.tsx',
  ])
})
