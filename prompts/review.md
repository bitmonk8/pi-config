---
description: Review changes with parallel review lens agents; each lens writes to its own file and a consolidator merges them into a single committable report (user-level + any project-local lenses on the ancestry of the changed files)
---
Review the changes described by: $@

First, determine the review target and the appropriate git command(s). Examples:
- "uncommitted changes" → `git diff` and `git diff --cached`
- "commit hash 3798ef" → `git show 3798ef`
- "branch foo" → `git diff main...foo`
- "last 3 commits" → `git diff HEAD~3..HEAD`
- "PR 42" → `gh pr diff 42`
- If no argument is given, default to uncommitted changes.

Also compute a short `targetLabel` that is safe for use in filenames:
- uncommitted changes → `uncommitted`
- commit hash → `commit-<shortsha>`
- branch → `branch-<sanitized-branch-name>`
- `HEAD~N..HEAD` → `last-N`
- PR → `pr-<number>`

Run the git command(s) to gather the diff. Extract the list of changed file paths (both tracked and untracked) — call this `changedPaths`.

## Set up output paths

- `timestamp` = current local time as `YYYYMMDD-HHMMSS`.
- `tmpDir` = `.pi/tmp/review/<timestamp>-<targetLabel>/`
- `outPath` = `docs/reviews/review/<targetLabel>-<timestamp>.md`
- Create `tmpDir` (`mkdir -p`). Each lens will write to `<tmpDir>/<agent-name>.md`.

## Run lenses

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

Each task receives:
- The full diff as its `task` string.
- Its assigned output file path: `<tmpDir>/<agent-name>.md`.
- Instructions: **write your findings to that file**. Return only a one-line status: either `wrote N findings to <path>` or `no issues found; wrote marker to <path>`. Do NOT return the findings themselves — they must live only in the file.

**Do not** check whether agents exist before calling the subagent tool. The tool handles agent discovery automatically. Just call it.

**Failed agents:** If any agent fails or returns no status, **re-run that specific agent once**. If it fails again, note it as "agent unavailable" and continue. Do NOT skip the lens — always attempt the re-run.

## Consolidate

Collect the list of files actually written inside `tmpDir` (e.g. `ls <tmpDir>/*.md`) as `findingFiles`. Use the subagent tool to run the `consolidator` agent with:
- `findingFiles`: the list of per-lens files
- `outPath`: the committable report path computed above
- `target`: a short description of the diff target (e.g. `uncommitted changes`, `commit 3798ef`, `branch foo`)

The consolidator will merge and deduplicate across lenses, group findings by file and line range (not by lens), write the report to `outPath`, and return a short summary including `outPath`.

## Cleanup

After the consolidator returns successfully, delete `tmpDir` recursively (`rm -rf <tmpDir>`). If the consolidator failed, leave `tmpDir` in place so findings can be recovered manually and tell the user where they are.

## Report

Print the consolidator's returned summary verbatim. Do not re-print the full findings — they are in the committable file.
