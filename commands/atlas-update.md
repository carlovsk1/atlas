---
description: Refresh the Atlas index for files that changed since the last run
---

Refresh the Atlas index incrementally.

## Step 1: Re-extract changed files

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/atlas.mjs" --repo . --update
```

## Step 2: Re-synthesize only affected areas

Read `.claude/atlas/.state.json` and take its `commit` field. List what changed:

```bash
git diff --name-only <commit>..HEAD
```

For each `.claude/atlas/patterns/*.md` and `.claude/atlas/decisions/*.md` file
that cites a changed path, re-read the cited files and update that file. Leave
every other pattern and decision untouched.

If a cited path no longer exists, remove that citation. If a file ends up citing
nothing, delete it.

## Step 3: Report

State how many files were re-extracted and which patterns or decisions changed.
