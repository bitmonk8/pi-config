---
description: Lint, commit, push, and verify CI is green
---
Perform the following steps in order. Stop and report if any step fails.

## 1. Rust checks (if applicable)

If `Cargo.toml` exists in the project root:

1. Run `cargo fmt --all` to auto-format.
2. Run `cargo clippy --all-targets --all-features -- -D warnings`. If clippy reports warnings, fix them and re-run until clean.

## 2. Commit

1. Run `git status` and `git diff --stat` to see what changed.
2. Stage all changes with `git add -A`.
3. Generate a concise, conventional-commit-style message summarizing the changes.
4. Commit with that message.

## 3. Push

1. Push to the current branch's remote with `git push`.

## 4. Verify CI

1. Wait a few seconds for CI to register, then poll with `gh run list --branch <current-branch> --limit 1` until the latest run reaches a terminal state.
2. If the run **succeeded**, report success.
3. If the run **failed**, fetch logs with `gh run view <run-id> --log-failed`, diagnose the failure, fix the issue, then go back to step 1.
