# Working in this repository

This directory is **the canonical working copy** of `github.com/bitmonk8/pi-config`.
It lives inside `~/.pi/agent/git/github.com/bitmonk8/pi-config/` and is the same
clone that `pi` itself loads packages from.

There is **no other clone** on this machine. Do not create one — having two
clones in the past led to drift and uncommitted changes living in only one
of them.

## Why this matters

`pi update` runs `git pull` in this directory. If the working tree is dirty
when the remote has moved, you get a merge mess (or silent stash/loss of
changes). Treat this repo as if a background process can `git pull` it at
any time — because one can.

## Workflow rules

### Before you start editing
```bash
git status                       # must be clean
git pull --rebase origin main    # start from latest
```
If `git status` is **not** clean, stop and resolve the existing changes
(commit, discard, or stash with intent) before doing anything new.

### Before you push
```bash
git pull --rebase origin main    # in case remote moved while you worked
git push origin main
```

### Commit + push promptly
Do not leave uncommitted edits sitting around. Commit and push as soon
as a logical unit of work is done. The longer the working tree stays
dirty, the higher the chance `pi update` collides with it.

### Stay on `main`
Do not create local branches here. This clone exists to track `main`.
If you need to experiment, do it in a throwaway clone elsewhere
(e.g. `/tmp/pi-config-experiment`) and only land the result here via
a normal commit on `main`.

### Don't `git stash` and walk away
Stashes survive `pi update` but are invisible in normal workflow and
easy to forget. If you must stash, finish the round-trip in the same
session.

## If something goes wrong

- **Dirty tree blocking `pi update`**: commit it (preferred), or
  `git stash push -m "<why>"` and deal with it immediately after.
- **Rebase conflict during `pi update`**: resolve the conflict,
  `git add` the files, `git rebase --continue`, then push.
- **Lost changes**: check `git reflog` and `git stash list`. The
  reflog keeps unreachable commits for ~90 days by default.
