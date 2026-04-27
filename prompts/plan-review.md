---
description: Review an implementation plan against its spec with parallel plan-specific, reusable spec, and broad lenses (picks up project-local lenses on plan/spec ancestries)
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

2. **Run plan-specific lenses in parallel.** Use the subagent tool with the entries below as tasks and `targetPaths: [planPath, specPath]`. Pass each agent **both** the spec and the plan, clearly labeled:

   - plan-lens-spec-coverage
   - plan-lens-spec-fidelity
   - plan-lens-step-atomicity
   - plan-lens-ordering
   - plan-lens-validation
   - plan-lens-risk
   - `*-plan-lens-*` — pattern; expands to every project-local plan-lens agent discovered on the plan/spec ancestries.

3. **Run reusable spec lenses against the plan.** Use the subagent tool with the entries below as tasks and `targetPaths: [planPath, specPath]`. Each task runs against the **plan** (with the spec provided as context). They flag the same kinds of issues — ambiguity, contradictions, drifted naming, cruft, missing identifiers, hidden assumptions, misplaced content, and "could a fresh agent execute this without inventing?" — applied to the plan rather than the spec:

   - spec-lens-clarity
   - spec-lens-consistency
   - spec-lens-traceability
   - spec-lens-cruft
   - spec-lens-naming
   - spec-lens-placement
   - spec-lens-assumptions
   - spec-lens-implementability

4. **Run broad lenses in parallel.** Use the subagent tool with the entries below as tasks and `targetPaths: [planPath, specPath]`, running against the plan with full project read access:

   - spec-lens-codebase-grounding-broad — verify the plan's references to files, symbols, modules, and current behavior actually match the codebase.
   - spec-lens-doc-alignment-broad — verify the plan respects existing project documentation, conventions, and `AGENTS.md` rules.
   - `*-spec-lens-*-broad` — pattern; expands to every project-local broad spec-lens agent on the plan/spec ancestries.

   **Do not** check whether agents exist before calling the subagent tool. The tool handles agent discovery automatically.

   **Failed agents:** If any agent fails or returns empty output, **re-run that specific agent once**. If it fails again, note it as "agent unavailable" and continue with the results you have. Do NOT skip the lens — always attempt the re-run.

5. **Consolidated summary.** Print a single consolidated summary grouped by lens category, then by plan step (or section). Each finding should keep its lens tag. Omit categories with no findings. Do NOT create any files.
