---
description: Implement a spec with automatic review/fix loop (picks up project-local review lenses on the spec/diff ancestry)
---
Implement the task described in $@

If no argument was given, ask for a spec reference. Examples:
- `/implement specs/MY_FEATURE.md`
- `/implement "the task described in docs/TODO.md under 'Auth rewrite'"`

Record the concrete spec path as `specPath`.

## Steps

1. **Implement** — Use the subagent tool to run the implementer agent with the full spec contents. Pass `targetPaths: [specPath]` so any project-local agents on the spec's ancestry are also discoverable. The implementer will implement the code, update docs, and delete the spec file.

2. **Review/Fix Loop** — Immediately after the implementer finishes, run a review/fix loop on all uncommitted changes until clean.

   Use this hardcoded policy:
   - **Trust issues are always fixed** — a new feature ships with accurate docs, honest tests, and no misleading state.
   - **High fix Complexity or Risk with low impact:** document instead of fix.
   - **High fix Complexity or Risk with marginal impact:** ignore.
   - **Everything else:** fix.

   ### Loop

   **A. Review** — Run `git diff` and `git diff --cached`. Combine tracked diffs and untracked new files into the review payload. Extract the list of changed file paths — call this `changedPaths`.

   Use the subagent tool in parallel mode with the entries below as tasks and `targetPaths: changedPaths`:

   - review-lens-correctness
   - review-lens-cruft
   - review-lens-doc-mismatch
   - review-lens-error-handling
   - review-lens-naming
   - review-lens-placement
   - review-lens-separation
   - review-lens-simplification
   - review-lens-testing
   - `*-review-lens-*` — pattern; expands to every project-local review-lens agent on the ancestries of the changed files.

   Each task receives the full diff as its `task` string.

   **Do not** check whether agents exist before calling the subagent tool. The tool handles agent discovery from packages, bundled dirs, user dirs, and project-local `.pi/agents/` directories on the ancestry of `targetPaths` automatically. Just call it.

   **Failed agents:** If any agent fails or returns empty output, **re-run that specific agent once**. If it fails again, note it as "agent unavailable" and continue with the results you have. Do NOT skip the lens — always attempt the re-run.

   **B. Triage** — Use the subagent tool to run the `triage-assessor` agent with all findings.

   **C. Apply Policy & Fix** — Classify each finding per the policy above.
   - Fix: use the subagent tool to run `fixer` sequentially.
   - Document: append to issue tracker (check `docs/ISSUES_CONFIG.md`, default `file` backend at `docs/ISSUES.md`).
   - Ignore: skip.

   **D. Re-review or terminate** — If any fixes were applied, go back to A. If **zero** findings were classified as "fix" in this iteration, the loop is done. You MUST re-review after every round of fixes — fixes can introduce new issues or make doc counts stale.

3. **Summary** — Print what was implemented, fixed, documented, and ignored. Do NOT create report files.
