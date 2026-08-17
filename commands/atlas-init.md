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

Then ask the history where the undocumented rules are:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/atlas.mjs" --repo . --candidates
```

It lists files whose commits keep correcting the same thing, which is where a rule
nobody wrote down usually lives, with the commits as evidence. A commit is a source
like an ADR is a source, on one condition: the subject has to actually say what was
decided. `fix(proposals): gate the purchase-date rule and rescue legacy basis rows`
is a source. `fix: address review` is not, it only proves something was corrected.
When the subjects are thin, run `--history` on the file and read the diff before
writing anything, or write nothing.

For each decision recorded in an ADR, a doc, or a commit history that states it,
write `.claude/atlas/decisions/<slug>.md`:

```markdown
# <Decision>

**Source:** `docs/adr/001-example.md`, or the commit SHAs that establish it

**Decision:** one sentence.

**Why:** the reasoning, quoted or summarized from the source.

**Affects:** `path/to/file.ts`, `path/to/other.ts`
```

Hard rules:
- Never invent a pattern you cannot point two real files at.
- Never invent a decision that has no source. If the "why" is not written down
  anywhere, in a doc or in a commit that states it, do not write the file.
- Every path you cite must exist, and every SHA you cite must resolve. Verify
  before writing.

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
