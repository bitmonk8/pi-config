---
description: Implement a spec with automatic review/fix loop
---
Implement the task described in $@

If no argument was given, ask for a spec reference. Examples:
- `/implement specs/MY_FEATURE.md`
- `/implement "the task described in docs/TODO.md under 'Auth rewrite'"`

## Steps

1. **Implement** — Use the subagent tool to run the implementer agent with the full spec contents. It will implement the code, update docs, and delete the spec file.

2. **Review/Fix Loop** — Immediately after the implementer finishes, run a review/fix loop on all uncommitted changes until clean.

   Use this hardcoded policy:
   - **Trust issues are always fixed** — a new feature ships with accurate docs, honest tests, and no misleading state.
   - **High fix Complexity or Risk with low impact:** document instead of fix.
   - **High fix Complexity or Risk with marginal impact:** ignore.
   - **Everything else:** fix.

   ### Loop

   **A. Review** — Run `git diff` and `git diff --cached`. Use subagent to run all 9 review lens agents in parallel with the diff.

   **B. Triage** — Use subagent to run the triage-assessor agent with all findings.

   **C. Apply Policy & Fix** — Classify each finding per the policy above.
   - Fix: use subagent to run fixer sequentially.
   - Document: append to issue tracker (check `docs/ISSUES_CONFIG.md`, default `file` backend at `docs/ISSUES.md`).
   - Ignore: skip.

   **D. Re-review or terminate** — If any fixes were applied, go back to A. Otherwise done.

3. **Summary** — Print what was implemented, fixed, documented, and ignored. Do NOT create report files.
