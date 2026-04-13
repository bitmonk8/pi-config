---
description: Review/triage/fix loop until clean
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
Run the appropriate git diff command(s) to get the diff. Use the subagent tool to
run all 9 review lens agents **in parallel** with the full diff:
review-lens-correctness, review-lens-simplification, review-lens-testing,
review-lens-cruft, review-lens-separation, review-lens-naming, review-lens-placement,
review-lens-doc-mismatch, review-lens-error-handling

Consolidate findings grouped by file, tagged by category.

### Step 2: Triage
Use the subagent tool to run the triage-assessor agent with all findings.
Print the triage results, then IMMEDIATELY continue to Step 3.

### Step 3: Apply Policy & Fix
For each assessed finding, apply the policy to classify as **fix**, **document**, or **ignore**.

- **Fix:** use subagent to run the fixer agent sequentially (one at a time) with the
  issue description and file path.
- **Document:** Read `docs/ISSUES_CONFIG.md` for the issue tracking backend
  (default: `file` backend, path `docs/ISSUES.md`).
  - `github` backend: create GitHub Issue via `gh issue create` with File(s), Issue,
    Impact, Fix Cost sections and appropriate labels.
  - `file` backend: append to the issues file with cost/benefit metadata, sorted by
    actionability.
- **Ignore:** skip.

### Step 4: Re-review or terminate
- If fixes were applied in Step 3, go back to Step 1 (using the same diff target).
- If no findings were classified as "fix," the loop is done.

## Summary (only after loop terminates)
Print what was fixed, documented, and ignored. Do NOT create report files.
