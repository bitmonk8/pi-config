---
description: Audit a target with narrow and broad lens reviews, triage, and interactive fixes (picks up project-local lenses on target ancestries)
---
Perform a full audit of: **$ARGUMENTS**

## Phase 1: Discovery & Plan

1. Identify the files to audit based on the target (`$ARGUMENTS`):
   - For the entire project: run `git ls-files` to enumerate all tracked files.
   - For a specific directory or file path: enumerate files within the given path.
   Record the enumerated list as `allPaths`.
2. Classify each file as code or documentation.
3. Write `docs/AUDIT.md` with the review plan: target, file list, agent counts, batching strategy.

## Phase 2: Narrow-lens reviews

For each file `f` in `allPaths`, use the subagent tool in parallel mode with the entries below as tasks and `targetPaths: [f]`. Run in batches of up to 16 parallel tasks.

Agents:
- review-lens-correctness
- review-lens-simplification
- review-lens-testing
- review-lens-cruft
- review-lens-separation
- review-lens-naming
- review-lens-placement
- review-lens-doc-mismatch
- review-lens-error-handling
- `*-review-lens-*` — pattern; expands to every project-local review-lens agent on `f`'s ancestry.

Collect findings as:
```
### [Category] File: path/to/file
- **Line(s):** N-M
- **Description:** ...
```

Skip entries with no findings.

## Phase 3: Broad-lens reviews

Use subagent in parallel mode with the entries below as tasks and `targetPaths: allPaths`, each task receiving a summary of the audit target:

- review-lens-correctness-broad
- review-lens-simplification-broad
- review-lens-separation-broad
- review-lens-naming-broad
- review-lens-placement-broad
- review-lens-doc-mismatch-broad
- `*-review-lens-*-broad` — pattern; expands to every project-local broad review-lens agent on the target ancestries.

Only report cross-file issues.

## Phase 4: Consolidation

Use subagent to run the consolidator agent with all findings to deduplicate and organize.

## Phase 5: Triage

Use subagent to run the triage-assessor agent with consolidated findings to validate and assign cost/benefit metadata.

## Phase 6: Interactive Action

Present each assessed finding with its cost/benefit metadata. Ask the user to decide: **fix**, **document**, or **ignore**.

- **Fix:** use subagent to run fixer sequentially.
- **Document:** check `docs/ISSUES_CONFIG.md` for backend (default: `file` at `docs/ISSUES.md`). Create GitHub Issues or append to file as configured.
- **Ignore:** skip.

Print a summary when done. Do NOT create report files beyond `docs/AUDIT.md`.
