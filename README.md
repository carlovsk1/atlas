# Atlas

A Claude Code plugin that indexes a repository into a context graph the agent
consults before writing new code, so it stops reinventing what already exists and
stops forgetting why things are the way they are.

## Install

```bash
/plugin marketplace add carlovsk1/atlas
/plugin install atlas@atlas
```

## Use

In any repository:

```
/atlas-init      # first full index
/atlas-update    # refresh what changed
/atlas-graph     # build and open the import graph
```

The `atlas` skill then fires on its own whenever you ask for a new component,
hook, util, route, or table, or when you are about to change a file others import.

## Asking the index

The index is a query surface, not a document to read. On a 2,064-file monorepo
`inventory/utils.md` is 405KB, about 104k tokens: too expensive to open in order to
learn that a function already exists. The same question costs seven lines here.

```bash
atlas=".../atlas/scripts/atlas.mjs"          # ${CLAUDE_PLUGIN_ROOT}/scripts/atlas.mjs

node "$atlas" --repo . --find formatCurrency        # does this already exist, and where
node "$atlas" --repo . --rdeps src/lib/money.ts     # who breaks if I change this
node "$atlas" --repo . --deps src/lib/money.ts      # what this file needs to work
node "$atlas" --repo . --impact                     # blast radius of the working tree
node "$atlas" --repo . --history src/lib/money.ts   # why this file looks like it does
node "$atlas" --repo . --candidates                 # files whose history hides a rule
```

`--deps` and `--rdeps` accept `--depth N`. Queries read the index and never rebuild
it. An answer from a production monorepo, with the paths generalized:

```
6 matches
formatCurrency  function  packages/shared/src/utils/format.ts:1            packages/shared
formatCurrency  function  packages/web/src/components/billing/format.ts:10 packages/web
formatCurrency  const     packages/web/src/lib/format-total.ts:8           packages/web
```

## Three hooks, so consulting the index is not a matter of remembering

A skill fires when the model decides it applies. Hooks fire because the harness runs
them. All three do nothing until you have run `/atlas-init` once, and all three are
silent on failure: Atlas must never be the reason an edit did not happen.

| Hook | When | What it does |
|---|---|---|
| `UserPromptSubmit` | every prompt | States that an index exists and the three commands that query it, about 130 tokens |
| `PreToolUse` on `Write` | new code file | Extracts the names the file would export and denies the write if the repository already exports one, with the locations |
| `PostToolUse` on edits | after every edit | Re-indexes incrementally, about 0.1s, so the index never goes stale mid-session |

The gate is the interesting one, because it does not tell the model to go and check.
The check has already run and its result is the denial:

```
Atlas: this repository already exports this name.

formatCurrency:
  packages/shared/src/utils/format.ts:1  function
  packages/web/src/components/billing/format.ts:10  function
  packages/web/src/components/orders/order-document/format.ts:1  function
  ... and 1 more
```

It fires once per file per session, so a deliberate second write goes through. It
only reads names of four characters or more, because `id` and `db` collide by
accident and a warning nobody can act on is worse than no warning.

## What it writes

Everything lands in `.claude/atlas/`. Commit the Markdown, which is what a human
reviews in a pull request, and ignore the derived files, which the hook rewrites on
every edit and which rebuild in under a second:

```gitignore
.claude/atlas/.state.json
.claude/atlas/graph.json
.claude/atlas/graph.html
```

The tradeoff is explicit: a teammate who clones the repository gets the reviewable
Markdown but has to run `/atlas-init` once, because queries read `graph.json` and
refuse to rebuild it behind your back. Commit those three files instead if you would
rather trade a noisy diff for a working index on clone.

| Path | Contents |
|---|---|
| `INDEX.md` | Hub linking every map |
| `inventory/*.md` | Exported symbols, routes, and tables with `path:line` |
| `patterns/*.md` | Recurring conventions with canonical examples |
| `decisions/*.md` | Recorded decisions, sourced from your ADRs, docs, and commit history |
| `.state.json` | Per-file hashes and raw import specifiers, for incremental runs |
| `graph.json` | Areas, files, symbols, and the import edges between files |
| `graph.html` | Self-contained viewer, written only by `/atlas-graph` |

## The graph

`/atlas-graph` writes `.claude/atlas/graph.html`, a single file with the graph
inlined. It opens from `file://` with no server, no network, and no dependencies.

Nodes are files, edges are resolved imports. The view opens at the area level and
drills down one directory at a time: double click a node to go inside it, click to
inspect it, Escape to come back up. A node sits outside the current scope, drawn
dashed, when something inside the scope imports it from elsewhere in the repository.

Specifiers are resolved against the set of indexed files, never against the disk, so
a dependency in `node_modules` never becomes an edge. Relative paths, `tsconfig`
path aliases, and workspace package names all resolve; a `tsconfig` that inherits
its aliases through `extends` does not. Import edges are a JavaScript and TypeScript
idea: Python and SQL files are indexed for their symbols and appear as nodes without
edges.

## Requirements

Node 20 or newer and `git`. No other dependencies.

## Configuration

Optional `atlas.config.json` at the repository root:

```json
{
  "areas": {
    "engine/pricing": "pricing"
  }
}
```

## Limits

Extraction is regex-based, not AST-based, so exotic re-exports and complex
barrel files can be missed. This is deliberate: the consumer is a model that
opens the file before using a symbol, not a compiler.

Validated against a 433 tracked-file clone of a production Python and TypeScript
repository (467 indexable files). Five spot-checked `path:line` entries all
pointed at the exact declaration named. The run also surfaced patterns a
five-file fixture cannot:

- FastAPI routes lose their router prefix. A file declaring
  `APIRouter(prefix="/admin")` yields a `GET /stats` entry when the real URL is
  `GET /admin/stats`. In the validation run, 25% of route entries were missing
  their prefix this way.
- Exported classes are listed in `data.md` rather than `utils.md`, because the
  `data` bucket holds type definitions and a class is treated as one. A service
  implemented as a class appears there too, not alongside the functions it is
  used with.
- Purpose text is rare in practice: only about 35 of 1,568 entries (2%) carried
  a genuinely useful description once malformed extraction was excluded. Treat
  `path:line` and the name as the reliable part of an entry; treat purpose as a
  bonus, not something to depend on. How rare depends on the repository: a second
  validation repository, heavily commented, filled 39% of its entries.

`--candidates` reads commit subjects, not diffs. A subject like
`fix(orders): gate the purchase-date rule` states a decision and can be cited; a
subject like `fix: address review` only proves something was corrected and cannot.
On the validation monorepo about two thirds of the candidates carried enough of a
story to write a decision from, and build artifacts such as `.deploy-version` ranked
high on churn while meaning nothing. The output is evidence for a model to read, not
a decision, and a repository with thin commit messages will produce thin evidence.

A second run against a 2,064-file TypeScript monorepo indexed 6,460 entries in
under half a second and resolved 6,791 of 9,317 import specifiers (73%). Every
unresolved specifier was correctly out of scope: 2,519 dependencies from
`node_modules`, and 7 pointing at CSS, JSON, and `.d.ts` files, which Atlas does
not index. No import that targeted an indexed file was missed.

## Development

```bash
npm test
```
