---
description: Show issue counts by importance/effort with type and crate breakdowns
---
Generate an overview of open GitHub issues for the current project.

## Configuration

Read `docs/ISSUES_CONFIG.md` to determine the repo. Use `gh issue list` to fetch all open issues with their labels.

## Filter

Optional filter argument: $@

If a filter is provided, only count issues whose labels match the filter criteria. Interpret the filter naturally — e.g., "bugs and performance" means issues with `type:bug` or `type:performance` labels. "high importance" means `importance:high`. "lot crate" means `crate:lot`. Combine as needed.

If no filter is provided, count all open issues.

## Fetching

Fetch ALL open issues (use `--limit 500` or paginate if needed). Each issue may have labels like:
- `importance:low`, `importance:medium`, `importance:high`
- `effort:low`, `effort:medium`, `effort:high`
- `type:bug`, `type:testing`, `type:security`, `type:performance`, `type:complexity`, `type:naming`, `type:docs`, `type:placement`
- `crate:flick`, `crate:lot`, `crate:reel`, `crate:vault`, `crate:epic`, `crate:mech`, etc.

Issues missing importance or effort labels should be grouped under `unlabeled` for that axis.

## Output

### Summary Table

Show a single count-per-bucket table. Order buckets by importance descending (high → medium → low → unlabeled), then by effort ascending (low → medium → high → unlabeled) within each importance level.

Format:

```
importance:high / effort:low     — 5 issues
importance:high / effort:medium  — 3 issues
importance:high / effort:high    — 1 issue
importance:medium / effort:low   — 12 issues
...
```

Omit empty buckets.

### Per-Bucket Breakdown

Under each bucket, show:
1. **Type breakdown** — count per `type:*` label (e.g., `bug: 3, complexity: 2, naming: 1`)
2. **Crate breakdown** — count per `crate:*` label, only if at least one issue in the bucket has a crate label (e.g., `flick: 2, lot: 1`). Omit this line entirely if no issues in the bucket have crate labels.

### Totals

After all buckets, show the total issue count (filtered if a filter was applied, with a note stating the filter).

Do NOT create any files. Print the overview directly.
