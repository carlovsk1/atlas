---
name: atlas
description: Use BEFORE creating any component, hook, utility, route, endpoint, table, migration, or type, and before adding a new dependency. Also use when asked "where is", "does this already exist", "what is the pattern here", or "why is this like this". Checks the repository's Atlas index so existing code is reused instead of reinvented and recorded decisions are respected.
---

# Consulting the Atlas index

## When this applies

Any time you are about to add code that could already exist, or to make a choice
someone already made and wrote down.

## The one rule

**The index is for discovery and decision, never a source of signatures.**

Names, purposes, and locations come from the index. Parameters, types, props, and
return values come from opening the file. An index entry is a pointer, not a
declaration. This is what keeps a slightly stale index from becoming a confident
hallucination.

## Steps

1. **Check freshness.** Read `.claude/atlas/.state.json`, take its `commit`
   field, and run:

   ```bash
   git diff --name-only <commit>..HEAD | wc -l
   ```

   Zero to a handful: trust the index. Dozens: treat every entry as a hint and
   confirm in the code. Missing `.state.json`: there is no index, say so and
   suggest `/atlas-init`. `commit` is `null`: the repository had no commits when
   it was indexed, so there is no baseline to diff against. Skip the diff, treat
   the index as unverifiable rather than stale, and say so before relying on it.

2. **Read `.claude/atlas/INDEX.md`.** It is the hub. Do not read every inventory
   file.

3. **Open only the relevant bucket.** Creating a component reads
   `inventory/components.md`. Adding an endpoint reads `inventory/routes.md`.
   Touching the schema reads `inventory/data.md`.

4. **Check patterns and decisions** for the area you are about to change. If a
   decision covers it, follow it or say explicitly why you are departing from it.

5. **Open the file before using anything.** If you found a candidate to reuse,
   read it at the listed `path:line` and work from the real signature.

6. **If nothing matches, say so** before writing new code: "Atlas has no existing
   X, creating a new one." That sentence is the evidence you actually looked.

## When the index is missing or stale

Never guess to fill a gap. An absent entry means "not indexed", not "does not
exist". Fall back to searching the code directly, and suggest `/atlas-update`.
