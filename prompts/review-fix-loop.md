---
description: Review/triage/fix loop on uncommitted changes until clean
---
Run a review/triage/fix loop on all uncommitted changes, applying this policy: $@

If no policy argument was given, ask for one. Examples:
- "fix defects and security issues, document maintainability, ignore readability"
- "fix everything where effort is under ~20 LOC, document the rest"
- "only fix trust issues in the auth module, ignore everything else"

This is an autonomous loop. Do NOT stop or wait for user input between steps.

## Loop

### Step 1: Review
Run `git diff` and `git diff --cached`. Use the subagent tool to run all 9 review lens agents in parallel with the diff:
review-lens-correctness, review-lens-simplification, review-lens-testing, review-lens-cruft, review-lens-separation, review-lens-naming, review-lens-placement, review-lens-doc-mismatch, review-lens-error-handling

Consolidate findings grouped by file, tagged by category.

### Step 2: Triage
Use the subagent tool to run the triage-assessor agent with all findings. Print the triage results, then IMMEDIATELY continue to Step 3.

### Step 3: Apply Policy & Fix
For each assessed finding, apply the policy to classify as **fix**, **document**, or **ignore**.

- **Fix:** use subagent to run the fixer agent sequentially (one at a time) with the issue description and file path.
- **Document:** Read `docs/ISSUES_CONFIG.md` for the issue tracking backend (default: `file` backend, path `docs/ISSUES.md`).
  - `github` backend: create GitHub Issue via `gh issue create` with File(s), Issue, Impact, Fix Cost sections and appropriate labels.
  - `file` backend: append to the issues file with cost/benefit metadata, sorted by actionability.
- **Ignore:** skip.

### Step 4: Re-review or terminate
- If any fixes were applied, go back to Step 1.
- If no findings were classified as "fix," the loop is done.

## Summary (only after loop terminates)
Print what was fixed, documented, and ignored. Do NOT create report files.
