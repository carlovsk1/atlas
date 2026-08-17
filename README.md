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
  bonus, not something to depend on.

## Development

```bash
npm test
```
