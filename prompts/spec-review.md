---
description: Review a spec with parallel narrow and broad spec-review lenses; each lens writes to its own file and a consolidator merges them into a single committable report (picks up project-local lenses on the spec's ancestry)
---
Review the spec described by: $@

If no argument was given, ask for a spec reference. Examples:
- `/spec-review specs/MY_FEATURE.md`
- `/spec-review "the proposal in docs/proposals/AUTH_REWRITE.md"`
- `/spec-review "the section 'Phase 1' in docs/TODO.md"`

## Steps

1. **Locate the spec.** Resolve the reference to a concrete file (or section within a file) and read its full contents. If the reference is a section, extract that section verbatim — the lenses must see exactly what the implementer would consume. Record the concrete spec path as `specPath`.

2. **Set up output paths.**
   - `timestamp` = current local time as `YYYYMMDD-HHMMSS`.
   - `specBasename` = basename of `specPath` without extension (for section references, pick a sensible slug).
   - `tmpDir` = `.pi/tmp/spec-review/<timestamp>-<specBasename>/`
   - `outPath` = `docs/reviews/spec-review/<specBasename>-<timestamp>.md`
   - Create `tmpDir` (e.g. `mkdir -p`). The lens agents will each write to `<tmpDir>/<agent-name>.md`.

3. **Run narrow lenses in parallel.** Use the subagent tool with the entries below as tasks and `targetPaths: [specPath]`. Each task receives:
   - The full spec contents.
   - Its assigned output file path: `<tmpDir>/<agent-name>.md`.
   - Instructions: **write your findings to that file** using the format your agent definition specifies. Return only a one-line status: either `wrote N findings to <path>` or `no issues found; wrote marker to <path>`. Do NOT return the findings themselves — they must live only in the file.

   Lenses:
   - spec-lens-clarity
   - spec-lens-completeness
   - spec-lens-testability
   - spec-lens-consistency
   - spec-lens-scope
   - spec-lens-assumptions
   - spec-lens-traceability
   - spec-lens-prescription
   - spec-lens-cruft
   - spec-lens-naming
   - spec-lens-placement
   - spec-lens-error-model
   - spec-lens-implementability
   - `*-spec-lens-*` — pattern; expands to every project-local narrow spec-lens agent discovered on the spec's ancestry. Pattern matches names with a prefix dash, so user-level `spec-lens-*` and broad `spec-lens-*-broad` are excluded.

4. **Run broad lenses in parallel.** Same contract as step 3 (write to `<tmpDir>/<agent-name>.md`, return only a status line). `targetPaths: [specPath]`.

   - spec-lens-codebase-grounding-broad
   - spec-lens-cross-spec-consistency-broad
   - spec-lens-doc-alignment-broad
   - `*-spec-lens-*-broad` — pattern; expands to every project-local broad spec-lens agent discovered on the spec's ancestry.

   **Do not** check whether agents exist before calling the subagent tool. The tool handles agent discovery automatically.

   **Failed agents:** If any agent fails or returns no status, **re-run that specific agent once**. If it fails again, note it as "agent unavailable" and continue. Do NOT skip the lens — always attempt the re-run.

5. **Consolidate.** Collect the list of files that were actually written inside `tmpDir` (e.g. `ls <tmpDir>/*.md`) as `findingFiles`. Use the subagent tool to run the `consolidator` agent with:
   - `findingFiles`: the list of per-lens files
   - `outPath`: the committable report path from step 2
   - `target`: `specPath`

   The consolidator will merge and deduplicate across lenses, group findings by spec section / location (not by lens), write the report to `outPath`, and return a short summary that includes `outPath`.

6. **Cleanup.** After the consolidator returns successfully, delete `tmpDir` recursively (e.g. `rm -rf <tmpDir>`). If the consolidator failed, leave `tmpDir` in place so findings can be recovered manually and tell the user where they are.

7. **Report.** Print the consolidator's returned summary verbatim (it already contains `outPath` and a one-line overview). Do not re-print the full findings — they are in the committable file.
