---
description: Build the Atlas import graph and open the viewer
---

Refresh the index and build the graph viewer for the current repository.

## Step 1: Build

Run from the repository root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/atlas.mjs" --repo . --update --graph
```

Report the entry and import-edge counts it prints. If it exits non-zero, stop and
show the error.

## Step 2: Open

Open `.claude/atlas/graph.html` with the platform opener: `open` on macOS,
`xdg-open` on Linux, `start` on Windows. The page is self-contained and needs no
server and no network.

## Step 3: Report

Tell the user how many files and import edges the graph holds, and that the viewer
opens at the area level: double click a node to go inside it, click to inspect it,
Escape to go back up.
