---
description: Review changes with parallel review lens agents (user-level + any project-local lenses on the ancestry of the changed files)
---
Review the changes described by: $@

First, determine the review target and the appropriate git command(s). Examples:
- "uncommitted changes" → `git diff` and `git diff --cached`
- "commit hash 3798ef" → `git show 3798ef`
- "branch foo" → `git diff main...foo`
- "last 3 commits" → `git diff HEAD~3..HEAD`
- "PR 42" → `gh pr diff 42`
- If no argument is given, default to uncommitted changes.

Run the git command(s) to gather the diff. Extract the list of changed file paths (both tracked and untracked) — call this `changedPaths`.

Use the subagent tool in parallel mode with every entry below as a task and with `targetPaths: changedPaths` so project-local review lenses on the ancestry of any changed file are also discovered and fanned out:

- review-lens-correctness
- review-lens-simplification
- review-lens-testing
- review-lens-cruft
- review-lens-separation
- review-lens-naming
- review-lens-placement
- review-lens-doc-mismatch
- review-lens-error-handling
- `*-review-lens-*` — pattern; expands to every project-local review-lens agent discovered along the ancestries of `targetPaths` (e.g. `importservice-review-lens-dependency-injection`). Does not match user-level `review-lens-*` agents (those have no prefix dash) nor broad lenses (`review-lens-*-broad` — no prefix dash). Expands to zero when no matching project-local agents exist, which is fine.

Each task receives the full diff as its `task` string.

**Do not** check whether agents exist before calling the subagent tool. The tool handles agent discovery automatically. Just call it.

**Failed agents:** If any agent fails or returns empty output, **re-run that specific agent once**. If it fails again, note it as "agent unavailable" and continue with the results you have. Do NOT skip the lens — always attempt the re-run.

After all agents return, print a single consolidated summary grouped by file, with each finding tagged by lens category. Omit categories with no findings. Do NOT create any files.
