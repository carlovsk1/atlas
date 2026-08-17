---
description: Show what Atlas has actually done in this repository
---

Report the assists Atlas has recorded and the duplication the repository carries.

## Step 1: Read the ledger

Run from the repository root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/atlas.mjs" --repo . --report
```

If it exits non-zero, stop and show the error. `atlas: no assists recorded yet` is
not an error: it means the hooks have not had anything to say in this repository yet.

## Step 2: Report

Show the output as it printed, then read it back in one or two sentences. Two rules
about what you may say:

- Every count is an event that happened. `duplicates prevented` means a write was
  denied because the name already existed, not that a bug was avoided.
- Never claim what would have happened without Atlas. The counterfactual is not
  observable and stating it would be an invention.

`repo duplication` is the only line that does not come from Atlas reporting on
itself: it is recounted from the graph on every run, so it is the number to watch
over time. If it has a `most re-invented` list, name the top entry and where the
original lives, since that is the concrete thing to go and consolidate.
