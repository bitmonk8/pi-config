---
description: Review changes with 9 parallel review lens agents
---
Review the changes described by: $@

First, determine the review target and the appropriate git command(s). Examples:
- "uncommitted changes" → `git diff` and `git diff --cached`
- "commit hash 3798ef" → `git show 3798ef`
- "branch foo" → `git diff main...foo`
- "last 3 commits" → `git diff HEAD~3..HEAD`
- "PR 42" → `gh pr diff 42`
- If no argument is given, default to uncommitted changes.

Run the git command(s) to gather the diff, then use the subagent tool to run all 9 review lens agents **in parallel**, providing each with the full diff:

- review-lens-correctness
- review-lens-simplification
- review-lens-testing
- review-lens-cruft
- review-lens-separation
- review-lens-naming
- review-lens-placement
- review-lens-doc-mismatch
- review-lens-error-handling

After all agents return, print a single consolidated summary grouped by file, with each finding tagged by category. Omit categories with no findings. Do NOT create any files.
