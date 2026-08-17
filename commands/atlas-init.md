---
description: Build the full Atlas context index for this repository
---

Build the complete Atlas index for the current repository.

## Step 1: Extract the inventory

Run from the repository root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/atlas.mjs" --repo .
```

Report the counts it prints. If it exits non-zero, stop and show the error.

## Step 2: Synthesize patterns and decisions

Read, in this order and only if present: `CLAUDE.md`, `AGENTS.md`, `README.md`,
every file under `docs/`, and every file under `docs/adr/`. Then read
`.claude/atlas/inventory/*.md` produced in Step 1.

For each recurring convention you can support with at least two concrete
examples from the inventory, write `.claude/atlas/patterns/<slug>.md`:

```markdown
# <Pattern name>

**What we do:** one or two sentences.

**Canonical example:** `path/to/file.ts:12`

**Also follows this:** `path/to/other.ts:44`

**Applies when:** the situation that should trigger this pattern.
```

For each decision already recorded in an ADR or a doc, write
`.claude/atlas/decisions/<slug>.md`:

```markdown
# <Decision>

**Source:** `docs/adr/001-example.md`

**Decision:** one sentence.

**Why:** the reasoning, quoted or summarized from the source.

**Affects:** `path/to/file.ts`, `path/to/other.ts`
```

Hard rules:
- Never invent a pattern you cannot point two real files at.
- Never invent a decision that has no source document. If the "why" is not
  written down anywhere, do not write the file.
- Every path you cite must exist. Verify before writing.

## Step 3: Refresh the index

Run the extractor once more so `INDEX.md` links the files you just created:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/atlas.mjs" --repo . --update
```

## Step 4: Add the pointer

If `CLAUDE.md` does not already mention Atlas, append:

```markdown
## Context index

Before creating a component, hook, util, route, or table, consult
`.claude/atlas/INDEX.md` to check whether it already exists.
```

## Step 5: Report

Tell the user what was indexed, how many patterns and decisions were written,
and which files to review.
