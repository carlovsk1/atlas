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
```

The `atlas` skill then fires on its own whenever you ask for a new component,
hook, util, route, or table.

## What it writes

Everything lands in `.claude/atlas/` and should be committed, so the index is
reviewable in a pull request.

| Path | Contents |
|---|---|
| `INDEX.md` | Hub linking every map |
| `inventory/*.md` | Exported symbols, routes, and tables with `path:line` |
| `patterns/*.md` | Recurring conventions with canonical examples |
| `decisions/*.md` | Recorded decisions, sourced from your ADRs and docs |
| `.state.json` | Per-file hashes for incremental runs |
| `graph.json` | Nodes and edges, for visualization or future tooling |

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

Validated against a 433 tracked-file clone of a real production repository
(467 indexable files). Five spot-checked `path:line` entries all
pointed at the exact declaration named. The run also surfaced patterns a
five-file fixture cannot:

- Python `class` declarations are always extracted with kind `function`, so they
  never land in the `data` bucket and are indistinguishable from plain functions
  in `utils.md`. In the validation run, 256 of 1,140 top-level Python `def`/
  `class` declarations were classes (22%), all carrying the wrong kind.
- The purpose extractor only reads the single line directly above a
  declaration. A multi-line `/** ... */` block that closes on its own `*/` line
  is misread: the closing line itself is captured and mangled into a bare `/`
  instead of the real description, or instead of being left blank. In the
  validation run, 41 of the 82 non-blank purposes were this bogus `/`, and
  another 6 were stray comment dividers (`// ---...`) rather than descriptions.
- Files under `tests/` or matching `test_*.py` / `*.test.ts` are not excluded
  from indexing. In the validation run, 285 of 1,568 entries (18%) came from
  test fixtures and test classes, mixed into `utils.md` indistinguishably from
  production helpers.
- Purpose text is rare in practice: only about 35 of 1,568 entries (2%) carried
  a genuinely useful description once the two issues above are excluded. Treat
  `path:line` and the name as the reliable part of an entry; treat purpose as a
  bonus, not something to depend on.

## Development

```bash
npm test
```
