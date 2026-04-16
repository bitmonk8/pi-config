---
description: Audit a target with narrow and broad lens reviews, triage, and interactive fixes
---
Perform a full audit of: **$ARGUMENTS**

## Phase 1: Discovery & Plan

1. Identify the files to audit based on the target (`$ARGUMENTS`):
   - For the entire project: run `git ls-files` to enumerate all tracked files.
   - For a specific directory or file path: enumerate files within the given path.
2. Classify each file as code or documentation.
3. Write `docs/AUDIT.md` with the review plan: target, file list, agent counts, batching strategy.

## Phase 2: Narrow-lens reviews

For each file, use the subagent tool to run all 9 narrow review lens agents. Each invocation covers exactly ONE file and ONE lens. Run in batches of up to 16 parallel agents.

Agents: review-lens-correctness, review-lens-simplification, review-lens-testing, review-lens-cruft, review-lens-separation, review-lens-naming, review-lens-placement, review-lens-doc-mismatch, review-lens-error-handling

Collect findings as:
```
### [Category] File: path/to/file
- **Line(s):** N-M
- **Description:** ...
```

Skip entries with no findings.

## Phase 3: Broad-lens reviews

Use subagent to run all 6 broad lens agents in parallel with a summary of the audit target:
review-lens-correctness-broad, review-lens-simplification-broad, review-lens-separation-broad, review-lens-naming-broad, review-lens-placement-broad, review-lens-doc-mismatch-broad

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
