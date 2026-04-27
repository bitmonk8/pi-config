---
description: Review/triage/fix loop until clean (picks up project-local review lenses on the ancestry of the changed files)
---
Run a review/triage/fix loop, applying this policy: $@

If no policy argument was given, ask for one. Examples:
- "fix defects and security issues, document maintainability, ignore readability"
- "fix everything where effort is under ~20 LOC, document the rest"
- "only fix trust issues in the auth module, ignore everything else"

## Determine the diff target

If the argument contains a git range or ref (e.g. `abc123..def456`, `HEAD~3..HEAD`,
`-- mech/`, a commit hash, a branch name), extract it as the **diff target** and
use `git diff <target>` to produce the diff for each review step.

Otherwise, default to uncommitted changes: `git diff` + `git diff --cached`.

Examples of argument forms:
- `fix everything` → uncommitted changes, policy = "fix everything"
- `86578b5~1..9a8a621 -- mech/ | fix defects` → range = `86578b5~1..9a8a621 -- mech/`, policy = "fix defects"
- `HEAD~3..HEAD | fix everything under 20 LOC` → range = `HEAD~3..HEAD`, policy = "fix everything under 20 LOC"

The separator between range and policy is ` | `. If no ` | ` is present, the whole
argument is the policy (uncommitted changes) unless it parses as a git range.

This is an autonomous loop. Do NOT stop or wait for user input between steps.

## Loop

### Step 1: Review
Run the appropriate git diff command(s) to get the diff. Combine tracked diffs and untracked new files into the review payload. Extract the list of changed file paths — call this `changedPaths`.

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
- `*-review-lens-*` — pattern; expands to every project-local review-lens agent discovered along the ancestries of `targetPaths`. Pattern matches names with a prefix dash, so user-level `review-lens-*` agents and broad `review-lens-*-broad` agents are excluded.

Each task receives the full diff as its `task` string.

**Do not** check whether agents exist before calling the subagent tool. The tool handles agent discovery from packages, bundled dirs, user dirs, and project-local `.pi/agents/` directories on the ancestry of `targetPaths` automatically. Just call it.

**Failed agents:** If any agent fails or returns empty output, **re-run that specific agent once**. If it fails again, note it as "agent unavailable" and continue with the results you have. Do NOT skip the lens — always attempt the re-run.

Consolidate findings grouped by file, tagged by category.

### Step 2: Triage
Use the subagent tool to run the `triage-assessor` agent with all findings.
Print the triage results, then IMMEDIATELY continue to Step 3.

### Step 3: Apply Policy & Fix
For each assessed finding, apply the policy to classify as **fix**, **document**, or **ignore**.

- **Fix:** use the subagent tool to run `fixer` sequentially (one at a time) with the
  issue description and file path.
- **Document:** Read `docs/ISSUES_CONFIG.md` for the issue tracking backend
  (default: `file` backend, path `docs/ISSUES.md`).
  - `github` backend: create GitHub Issue via `gh issue create` with File(s), Issue,
    Impact, Fix Cost sections and appropriate labels.
  - `file` backend: append to the issues file with cost/benefit metadata, sorted by
    actionability.
- **Ignore:** skip.

### Step 4: Re-review or terminate
- If fixes were applied in Step 3, go back to Step 1 (using the same diff target, but now including uncommitted fix changes).
- If **zero** findings were classified as "fix" in this iteration, the loop is done.
- You MUST re-review after every round of fixes — fixes can introduce new issues or make doc counts stale.

## Summary (only after loop terminates)
Print what was fixed, documented, and ignored. Do NOT create report files.
