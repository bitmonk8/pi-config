---
description: Review a spec with parallel narrow and broad spec-review lenses (picks up project-local lenses on the spec's ancestry)
---
Review the spec described by: $@

If no argument was given, ask for a spec reference. Examples:
- `/spec-review specs/MY_FEATURE.md`
- `/spec-review "the proposal in docs/proposals/AUTH_REWRITE.md"`
- `/spec-review "the section 'Phase 1' in docs/TODO.md"`

## Steps

1. **Locate the spec.** Resolve the reference to a concrete file (or section within a file) and read its full contents. If the reference is a section, extract that section verbatim — the lenses must see exactly what the implementer would consume. Record the concrete spec path as `specPath`.

2. **Run narrow lenses in parallel.** Use the subagent tool with the entries below as tasks and `targetPaths: [specPath]`. Each task receives the full spec contents.

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

3. **Run broad lenses in parallel.** Use the subagent tool with the entries below as tasks and `targetPaths: [specPath]`. Each task receives the spec path and contents so agents can read the surrounding project as needed.

   - spec-lens-codebase-grounding-broad
   - spec-lens-cross-spec-consistency-broad
   - spec-lens-doc-alignment-broad
   - `*-spec-lens-*-broad` — pattern; expands to every project-local broad spec-lens agent discovered on the spec's ancestry.

   **Do not** check whether agents exist before calling the subagent tool. The tool handles agent discovery automatically.

   **Failed agents:** If any agent fails or returns empty output, **re-run that specific agent once**. If it fails again, note it as "agent unavailable" and continue with the results you have. Do NOT skip the lens — always attempt the re-run.

4. **Consolidated summary.** Print a single consolidated summary grouped by lens category, then by section / heading within the spec. Each finding should keep its lens tag so the user can see which concern raised it. Omit categories with no findings. Do NOT create any files.
