import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { extractImports, buildResolver } from '../scripts/lib/imports.mjs'

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-imports-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

test('extractImports finds every import form', () => {
  const specs = extractImports(
    [
      `import { a } from './a'`,
      `import b from "../b.js"`,
      `import './side-effect.css'`,
      `export { c } from './c'`,
      `export * from './d'`,
      `const e = require('./e')`,
      `const f = await import('./f')`,
      `import {`,
      `  g,`,
      `} from './g'`,
    ].join('\n')
  )

  assert.deepEqual(specs, [
    './a',
    '../b.js',
    './side-effect.css',
    './c',
    './d',
    './e',
    './f',
    './g',
  ])
})

test('extractImports ignores commented-out imports and repeats', () => {
  const specs = extractImports(
    [`// import { old } from './old'`, ` * import { doc } from './doc'`, `import { a } from './a'`, `import type { B } from './a'`].join('\n')
  )
  assert.deepEqual(specs, ['./a'])
})

test('a relative specifier resolves through the extension list', () => {
  const repo = repoWith({ 'src/a.ts': '', 'src/b.tsx': '' })
  const resolve = buildResolver(repo, new Set(['src/a.ts', 'src/b.tsx']))
  assert.equal(resolve('./b', 'src/a.ts'), 'src/b.tsx')
})

test('a directory specifier resolves to its index file', () => {
  const files = new Set(['src/a.ts', 'src/lib/index.ts'])
  const resolve = buildResolver(repoWith({}), files)
  assert.equal(resolve('./lib', 'src/a.ts'), 'src/lib/index.ts')
})

test('a .js specifier resolves to the .ts file that emits it', () => {
  const files = new Set(['src/a.ts', 'src/b.ts'])
  const resolve = buildResolver(repoWith({}), files)
  assert.equal(resolve('./b.js', 'src/a.ts'), 'src/b.ts')
})

test('a tsconfig alias resolves only inside the package that declares it', () => {
  const repo = repoWith({
    'packages/web/tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    'packages/api/tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
  })
  const files = new Set([
    'packages/web/src/page.tsx',
    'packages/web/src/lib/money.ts',
    'packages/api/src/lib/money.ts',
    'packages/api/src/handler.ts',
  ])
  const resolve = buildResolver(repo, files)

  assert.equal(resolve('@/lib/money', 'packages/web/src/page.tsx'), 'packages/web/src/lib/money.ts')
  assert.equal(resolve('@/lib/money', 'packages/api/src/handler.ts'), 'packages/api/src/lib/money.ts')
})

test('a tsconfig with comments and trailing commas still yields its aliases', () => {
  const repo = repoWith({
    'tsconfig.json': `{
      // the alias we care about
      "compilerOptions": {
        "baseUrl": ".",
        "paths": { "~/*": ["src/*"] },
      },
    }`,
  })
  const resolve = buildResolver(repo, new Set(['src/a.ts', 'src/util.ts']))
  assert.equal(resolve('~/util', 'src/a.ts'), 'src/util.ts')
})

test('an alias key containing /* survives next to a **/*.ts include', () => {
  const repo = repoWith({
    'packages/web/tsconfig.json': `{
      "compilerOptions": { "paths": { "@/*": ["./src/*"] } },
      "include": ["**/*.ts", ".next/types/**/*.ts"]
    }`,
  })
  const resolve = buildResolver(repo, new Set(['packages/web/src/page.tsx', 'packages/web/src/lib/log.ts']))
  assert.equal(resolve('@/lib/log', 'packages/web/src/page.tsx'), 'packages/web/src/lib/log.ts')
})

test('a workspace package name resolves to the file inside that package', () => {
  const repo = repoWith({ 'packages/shared/package.json': JSON.stringify({ name: '@recs/shared' }) })
  const files = new Set(['packages/web/src/page.tsx', 'packages/shared/src/money.ts', 'packages/shared/src/index.ts'])
  const resolve = buildResolver(repo, files)

  assert.equal(resolve('@recs/shared/money', 'packages/web/src/page.tsx'), 'packages/shared/src/money.ts')
  assert.equal(resolve('@recs/shared', 'packages/web/src/page.tsx'), 'packages/shared/src/index.ts')
})

test('a specifier that leaves the repository resolves to nothing', () => {
  const resolve = buildResolver(repoWith({}), new Set(['src/a.ts']))
  assert.equal(resolve('react', 'src/a.ts'), null)
  assert.equal(resolve('node:fs', 'src/a.ts'), null)
  assert.equal(resolve('./missing', 'src/a.ts'), null)
})

test('a specifier never resolves to the file that imported it', () => {
  const files = new Set(['src/index.ts', 'src/a.ts'])
  const resolve = buildResolver(repoWith({}), files)
  assert.equal(resolve('.', 'src/index.ts'), null)
})
