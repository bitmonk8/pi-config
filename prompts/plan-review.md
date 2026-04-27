---
description: Review an implementation plan against its spec with parallel plan-specific, reusable spec, and broad lenses; each lens writes to its own file and a consolidator merges them into a single committable report (picks up project-local lenses on plan/spec ancestries)
---
Review the plan described by: $@

Expected forms:
- `/plan-review plans/MY_FEATURE.md specs/MY_FEATURE.md`
- `/plan-review plans/MY_FEATURE.md` (the prompt will try to find a matching spec; if it cannot, it will ask)
- `/plan-review "the plan in docs/proposals/AUTH.md under 'Implementation Plan'" "the spec in docs/proposals/AUTH.md under 'Spec'"`

If no plan reference was given, ask for one. If no spec reference was given:
1. Look for an obviously matching spec (same basename, sibling `specs/` dir, etc.).
2. If none is found, ask the user to provide one. Do not proceed without a spec — the plan lenses depend on it.

## Steps

1. **Locate inputs.** Resolve both references to concrete files (or sections within files) and read their full contents. If either is a section, extract it verbatim — the lenses must see exactly what the implementer would consume. Record the concrete file paths as `planPath` and `specPath`.

2. **Set up output paths.**
   - `timestamp` = current local time as `YYYYMMDD-HHMMSS`.
   - `planBasename` = basename of `planPath` without extension (for section references, pick a sensible slug).
   - `tmpDir` = `.pi/tmp/plan-review/<timestamp>-<planBasename>/`
   - `outPath` = `docs/reviews/plan-review/<planBasename>-<timestamp>.md`
   - Create `tmpDir` (`mkdir -p`). Each lens will write to `<tmpDir>/<agent-name>.md`.

3. **Run plan-specific lenses in parallel.** Use the subagent tool with the entries below as tasks and `targetPaths: [planPath, specPath]`. Pass each agent **both** the spec and the plan, clearly labeled. Each task receives:
   - The spec and plan contents (labeled).
   - Its assigned output file path: `<tmpDir>/<agent-name>.md`.
   - Instructions: **write your findings to that file**. Return only a one-line status: either `wrote N findings to <path>` or `no issues found; wrote marker to <path>`. Do NOT return the findings themselves.

   Lenses:
   - plan-lens-spec-coverage
   - plan-lens-spec-fidelity
   - plan-lens-step-atomicity
   - plan-lens-ordering
   - plan-lens-validation
   - plan-lens-risk
   - `*-plan-lens-*` — pattern; expands to every project-local plan-lens agent discovered on the plan/spec ancestries.

4. **Run reusable spec lenses against the plan.** Same file-writing contract as step 3. `targetPaths: [planPath, specPath]`. Each task runs against the **plan** (with the spec provided as context). They flag the same kinds of issues — ambiguity, contradictions, drifted naming, cruft, missing identifiers, hidden assumptions, misplaced content, and "could a fresh agent execute this without inventing?" — applied to the plan rather than the spec:

   - spec-lens-clarity
   - spec-lens-consistency
   - spec-lens-traceability
   - spec-lens-cruft
   - spec-lens-naming
   - spec-lens-placement
   - spec-lens-assumptions
   - spec-lens-implementability

5. **Run broad lenses in parallel.** Same file-writing contract. `targetPaths: [planPath, specPath]`, running against the plan with full project read access:

   - spec-lens-codebase-grounding-broad — verify the plan's references to files, symbols, modules, and current behavior actually match the codebase.
   - spec-lens-doc-alignment-broad — verify the plan respects existing project documentation, conventions, and `AGENTS.md` rules.
   - `*-spec-lens-*-broad` — pattern; expands to every project-local broad spec-lens agent on the plan/spec ancestries.

   **Do not** check whether agents exist before calling the subagent tool. The tool handles agent discovery automatically.

   **Failed agents:** If any agent fails or returns no status, **re-run that specific agent once**. If it fails again, note it as "agent unavailable" and continue. Do NOT skip the lens — always attempt the re-run.

6. **Consolidate.** Collect the list of files actually written inside `tmpDir` (e.g. `ls <tmpDir>/*.md`) as `findingFiles`. Use the subagent tool to run the `consolidator` agent with:
   - `findingFiles`: the list of per-lens files
   - `outPath`: the committable report path from step 2
   - `target`: `planPath` (and mention `specPath` as context)

   The consolidator will merge and deduplicate across lenses, group findings by plan step / section / location (not by lens), write the report to `outPath`, and return a short summary including `outPath`.

7. **Cleanup.** After the consolidator returns successfully, delete `tmpDir` recursively (`rm -rf <tmpDir>`). If the consolidator failed, leave `tmpDir` in place so findings can be recovered manually and tell the user where they are.

8. **Report.** Print the consolidator's returned summary verbatim. Do not re-print the full findings — they are in the committable file.
