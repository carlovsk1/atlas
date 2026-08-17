---
name: atlas
description: Use BEFORE creating any component, hook, utility, route, endpoint, table, migration, or type, before changing a file other files import, and before adding a new dependency. Also use when asked "where is", "does this already exist", "what breaks if I change this", "what is the pattern here", or "why is this like this". Queries the repository's Atlas index so existing code is reused instead of reinvented, blast radius is known before editing, and recorded decisions are respected.
---

# Consulting the Atlas index

## When this applies

Any time you are about to add code that could already exist, change code other
files depend on, or make a choice someone already made and wrote down.

## The one rule

**The index is for discovery and decision, never a source of signatures.**

Names, locations, and dependencies come from the index. Parameters, types, props, and
return values come from opening the file. An index entry is a pointer, not a
declaration. This is what keeps a slightly stale index from becoming a confident
hallucination.

## Ask the index, do not read it

The index is a query surface, not a document. On a real monorepo,
`inventory/utils.md` is 405KB, roughly 104k tokens; the same question answered
through the CLI costs seven lines. Read the Markdown only when the CLI cannot run.

```bash
ATLAS="${CLAUDE_PLUGIN_ROOT}/scripts/atlas.mjs"

node "$ATLAS" --repo . --find formatCurrency        # does this already exist, and where
node "$ATLAS" --repo . --rdeps src/lib/money.ts     # who breaks if I change this
node "$ATLAS" --repo . --deps src/lib/money.ts      # what this file needs to work
node "$ATLAS" --repo . --impact                     # blast radius of the working tree
node "$ATLAS" --repo . --history src/lib/money.ts   # why this file looks like it does
```

`--deps` and `--rdeps` take `--depth N` for transitive hops; depth 1 is direct only.
Every query reads the index and never rebuilds it, so running one is always safe.

## Steps

1. **Before creating anything, `--find` it.** Search the name you were about to use
   and its near synonyms: `formatCurrency`, `formatMoney`, `currency`. Several hits
   in different areas is itself the finding, report it rather than adding one more.

2. **Open the file before using what you found.** Read it at the listed `path:line`
   and work from the real signature. This is the one rule.

3. **Before changing a file, `--rdeps` it.** Say the number out loud: "this is
   imported by 208 files" changes how the change should be made. A file with many
   importers wants a widening change, not a breaking one.

4. **When the question is why, read the decisions.** Check `.claude/atlas/decisions/`
   for the area, and `--history` on the file. If a decision covers what you are
   about to do, follow it or say explicitly why you are departing from it.

5. **If nothing matches, say so** before writing new code: "Atlas has no existing X,
   creating a new one." That sentence is the evidence you actually looked.

## What runs without you

Three hooks back this skill up. Every prompt carries a line naming the index and its
query commands. Writing a new code file whose exported names already exist in the
repository is denied once, with those locations attached: that denial is the answer
to step 1, so read it and reuse what it found rather than writing the same file
again. After every edit the index re-indexes itself.

## Freshness

A `PostToolUse` hook re-indexes after each edit, so the index does not go stale
inside this session. It drifts from work done outside the session: a pull, a rebase,
another editor. When that is likely, or when a query returns something the code
contradicts, check the baseline:

```bash
git diff --name-only "$(node -p "require('./.claude/atlas/.state.json').commit")"..HEAD | wc -l
git status --porcelain
```

Zero to a handful: trust the index. Dozens: treat every entry as a hint and confirm
in the code. A `commit` of `null` means the repository had no commits when it was
indexed, so there is no baseline; treat the index as unverifiable and say so.

## When the index is missing or stale

A query that fails with "Run /atlas-init" means there is no index. Say so, suggest
`/atlas-init`, and search the code directly this time. Never guess to fill a gap: an
absent entry means "not indexed", not "does not exist".
