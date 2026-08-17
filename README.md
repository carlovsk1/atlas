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
/atlas-report    # what Atlas has actually done here
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

node "$atlas" --repo . --without src/shared/shell.tsx --under "(dashboard)"
                                                    # who does NOT use it
```

`--deps` and `--rdeps` accept `--depth N`. Queries read the index and never rebuild
it. An answer from a production monorepo, with the paths generalized:

```
6 matches
formatCurrency  function  packages/shared/src/utils/format.ts:1            packages/shared
formatCurrency  function  packages/web/src/components/billing/format.ts:10 packages/web
formatCurrency  const     packages/web/src/lib/format-total.ts:8           packages/web
```

### The two names a symbol answers to

A re-export is indexed under the name it publishes, carrying the name it came from, so
one search finds both. Without it a search reports the declaration and stays silent
about the alias every consumer actually imports:

```
2 matches
PageScaffold         function                    src/components/shared/page-scaffold.tsx:40
AdvisorPageScaffold  reexport of PageScaffold    src/app/(advisor)/_components/page-scaffold.tsx:5
```

A re-export never counts as duplication. It is one implementation deliberately answering
to a second name, which is the opposite of the fork below.

### Forks, called out rather than listed

Two files declaring the same exported name is a copied primitive. In a flat list with a
few substring hits between them, it is exactly what a reader skims past, so it is stated
as a conclusion under the results:

```
PageHeader is declared in 2 files, likely a fork:
  src/app/(advisor)/_components/page-header.tsx
  src/components/shared/page-header.tsx
```

### Who does *not* use it

`--rdeps` answers adoption from the wrong end: it names the files that already use the
shared primitive, which is the half nobody was worried about. `--without` names the rest.

```
$ atlas --without src/components/shared/page-scaffold.tsx --under "(dashboard)"
298 of 313 files under `(dashboard)` never reach …/page-scaffold.tsx within 3 hops, 48 of them routes
src/app/(dashboard)/admin/api-keys/page.tsx      route /admin/api-keys
src/app/(dashboard)/advisors/page.tsx            route /advisors
```

Two things make the answer usable rather than a wall of paths. It walks **3 hops by
default**, because a page reaches a shell through the view it renders, not directly, and
at depth 1 every compliant page reads as a violation. And **route files sort first**, with
their own count in the header, because when the scope is a route group the pages are the
answer and the components under them are context.

`--under` is required. Unscoped, the answer is every file in the repository minus a
handful, and refusing is more useful than truncating to a cap.

## Four hooks, so consulting the index is not a matter of remembering

A skill fires when the model decides it applies. Hooks fire because the harness runs
them. All four do nothing until you have run `/atlas-init` once, and all four are
silent on failure: Atlas must never be the reason an edit did not happen.

| Hook | When | What it does |
|---|---|---|
| `UserPromptSubmit` | every prompt | States that an index exists and the three commands that query it, about 130 tokens, and answers `--find` and `--rdeps` up front for whatever the prompt named |
| `PreToolUse` on `Write` | new code file | Extracts the names the file would export and denies the write if the repository already exports one, with the locations |
| `PreToolUse` on `Grep`/`Bash` | search for a bare name | Answers the search from the index and denies it, when the pattern is a plain identifier the graph knows |
| `PostToolUse` on edits | after every edit | Re-indexes incrementally, about 0.1s, so the index never goes stale mid-session |

The prompt hook only searches when the prompt names something searchable: a camelCase
or PascalCase identifier, a backticked name, or a repository-relative path. A sentence
in plain prose never loads the graph and costs exactly what it did before. A name it
finds arrives with its locations, and a name it does not find is reported as free, so
either answer saves the `--find` call:

```
Atlas already looked up what your message names:
formatCurrency: 1 match
  packages/utils/src/currency.ts:2  function
parseShippingLabel: nothing in the index exports this
packages/utils/src/currency.ts is imported by 1 file
  apps/web/lib/invoice-total.ts
```

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

The search gate takes the same stance one step earlier. The prompt hook can only look
up what your message named, and most names are found mid-task, in the code — so a
`Grep` for `PageScaffold`, or the `grep -rl PageScaffold` that usually stands in for
it, is answered from the graph instead of run:

```
Atlas: `PageScaffold` is indexed, so this search is already answered.

  packages/web/src/components/shared/page-scaffold.tsx:40  function
```

It is deliberately narrow. The pattern has to be a plain identifier of four characters
or more that the index holds an exact match for; a regex, a string literal, a file
name, a path, or a name nothing exports all run untouched, because content is what
grep is for and a gate people work around is worse than no gate. Like the write gate
it fires once per name per session, so asking for the raw matches anyway costs one
repeated search.

## Whether any of this is helping

Every hook appends a line to `.claude/atlas/.ledger.jsonl` when it had something to
say, and `--report` reads it back:

```
$ node "$atlas" --repo . --report

1 day · 3 sessions

duplicates prevented    1   gate denied a Write
context delivered       3   a name asked for already existed
blast radius shown      1   dependents before an edit

most re-invented
  formatCurrency    3x   packages/utils/src/currency.ts:2

repo duplication  0 names exported from 2+ files
```

Read it for what it is. Each count is an event that happened, not an outcome:
`duplicates prevented` means a write was denied because the name already existed. What
would have happened without Atlas is not observable, and a number claiming otherwise
would be invented. A query that found nothing is not recorded, because learning that a
name is free is worth a call and not a trophy.

`repo duplication` is the exception, and the number to actually watch. It is recounted
from `graph.json` on every run rather than taken from the ledger, so it does not depend
on Atlas reporting on itself, and it only falls when duplication the tool pointed at
gets consolidated for real.

## What it writes

Everything lands in `.claude/atlas/`. Commit the Markdown, which is what a human
reviews in a pull request, and ignore the derived files, which the hook rewrites on
every edit and which rebuild in under a second:

```gitignore
.claude/atlas/.state.json
.claude/atlas/.ledger.jsonl
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
| `.ledger.jsonl` | One line per assist, appended by the hooks, read by `--report` |
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
opens the file before using a symbol, not a compiler. Concretely, a re-export is
read only when its braces open and close on one line; a multi-line
`export {\n  A,\n  B,\n} from './x'` yields nothing rather than a wrong answer.

`--without` inherits the resolver's blind spots: a file that reaches the target
through a specifier Atlas could not resolve, or through a dynamic `import()`,
reports as a gap. It is a list to check, not a verdict.

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
