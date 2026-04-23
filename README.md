# pi-config

Personal [pi coding agent](https://github.com/badlogic/pi-mono) configuration.

## Install

```bash
pi install git:git@github.com:bitmonk8/pi-config
```

## What's Included

### Extensions

- **subagent** — Delegate tasks to specialized subagents with isolated context windows. Supports single, parallel (up to 16, 8 concurrent), and chained execution.
- **slack** — Hybrid Slack integration: read tools route through Slack's MCP server (Claude Code OAuth token), write tools call the Slack Web API directly with a bot token from `~/.pi/slack-config.json`.
- **freepik** — Generate imagery from text prompts via the Freepik API. Supports Nano Banana Pro (default, Google Gemini 3 — best for technical diagrams/text-heavy compositions), Nano Banana Pro Flash (Gemini 3.1 Flash, faster/cheaper), Seedream 4.5 (typography & posters), Flux Kontext Pro (reference-image design), and Mystic (photorealistic). Set `FREEPIK_API_KEY` in your environment.
- **work-profile** — Switch between work and personal profiles.

### Agents

#### General Purpose

| Agent | Model | Purpose |
|-------|-------|---------|
| worker | Sonnet | General-purpose, full tool access |
| implementer | Sonnet | Spec → code → docs → delete spec |
| fixer | Sonnet | Apply minimal fix for a review finding, verify compilation/tests |
| consolidator | Sonnet | Deduplicate and organize review findings |
| triage-assessor | Sonnet | Validate findings, filter false positives, assign cost/benefit metadata |

#### Narrow Review Lenses (per-file, Haiku)

| Agent | Focus |
|-------|-------|
| review-lens-correctness | Logic errors, race conditions, broken invariants |
| review-lens-simplification | Unnecessary complexity, over-abstraction |
| review-lens-testing | Missing coverage, silently skipping tests |
| review-lens-cruft | Stale comments, dead code, outdated TODOs |
| review-lens-separation | Single-responsibility violations |
| review-lens-naming | Names that don't reflect behavior |
| review-lens-placement | Code in the wrong location/layer |
| review-lens-doc-mismatch | Docs that don't match implementation |
| review-lens-error-handling | Silent failures, swallowed errors |

#### Broad Review Lenses (cross-file, Sonnet)

| Agent | Focus |
|-------|-------|
| review-lens-correctness-broad | Interface contract violations across modules |
| review-lens-simplification-broad | Unnecessary abstraction layers |
| review-lens-separation-broad | Overlapping modules, circular dependencies |
| review-lens-naming-broad | Inconsistent naming across files |
| review-lens-placement-broad | Files in wrong part of project structure |
| review-lens-doc-mismatch-broad | Systemic doc-code divergence |

#### Narrow Spec-Review Lenses (single spec doc)

Run before `/implement` to catch problems in a spec while it is still cheap to fix.

| Agent | Focus |
|-------|-------|
| spec-lens-clarity | Ambiguity, weasel words, vague modals, multiple interpretations |
| spec-lens-completeness | Missing edge cases, undefined behaviors, gaps an agent would have to invent |
| spec-lens-testability | Acceptance criteria present, verifiable, free of untestable quality words |
| spec-lens-consistency | Internal contradictions, inconsistent terminology, conflicting requirements |
| spec-lens-scope | Missing non-goals, scope creep, multiple features bundled, unclear priority |
| spec-lens-assumptions | Unstated assumptions, hidden requirements, implicit dependencies |
| spec-lens-traceability | Uniquely identifiable requirements, structure that supports referencing |
| spec-lens-prescription | Right level of "what vs how" — over- or under-specification |
| spec-lens-cruft | TBDs, brainstorm leftovers, stale references, decision logs, mixed phases |
| spec-lens-naming | Concepts named multiple ways, names that don't reflect meaning |
| spec-lens-placement | NFRs in user stories, contracts in narrative prose, mixed abstraction levels |
| spec-lens-error-model | Failure modes, error responses, recovery, partial-failure semantics |
| spec-lens-implementability | Could a fresh agent implement this without inventing contracts or behavior? |

#### Broad Spec-Review Lenses (spec ↔ project)

| Agent | Focus |
|-------|-------|
| spec-lens-codebase-grounding-broad | Spec references real files, symbols, APIs; current-state claims are accurate |
| spec-lens-cross-spec-consistency-broad | Target spec doesn't contradict or duplicate other in-flight specs |
| spec-lens-doc-alignment-broad | Spec respects existing project docs, conventions, and AGENTS.md rules |

#### Plan-Review Lenses (plan ↔ spec)

Run **after** `/spec-review` is clean and **before** `/implement`. Each agent receives both the spec (as source of truth) and the plan (as artifact under review).

| Agent | Focus |
|-------|-------|
| plan-lens-spec-coverage | Every spec requirement and acceptance criterion is implemented by some plan step |
| plan-lens-spec-fidelity | No plan step does work the spec didn't request — no scope drift |
| plan-lens-step-atomicity | Each step is independently buildable, verifiable, reviewable |
| plan-lens-ordering | No step depends on what a later step builds; dependencies are honored |
| plan-lens-validation | Each step has a done-condition; each acceptance criterion is asserted |
| plan-lens-risk | Destructive / irreversible / risky steps declare rollback, flags, telemetry |

`/plan-review` also reuses these existing lenses against the plan: `spec-lens-clarity`, `spec-lens-consistency`, `spec-lens-traceability`, `spec-lens-cruft`, `spec-lens-naming`, `spec-lens-placement`, `spec-lens-assumptions`, `spec-lens-implementability`, `spec-lens-codebase-grounding-broad`, `spec-lens-doc-alignment-broad`.

### Prompt Templates

| Command | Description |
|---------|-------------|
| `/review [target]` | Run 9 review lenses in parallel on changes (default: uncommitted) |
| `/spec-review <spec>` | Run 13 narrow + 3 broad spec lenses in parallel on a spec |
| `/plan-review <plan> [<spec>]` | Run 6 plan lenses + 8 reusable spec lenses + 2 broad lenses on a plan, with the spec as context |
| `/review-fix-loop <policy>` | Autonomous review → triage → fix loop until clean |
| `/implement <spec>` | Implement spec + automatic review/fix loop |
| `/project-audit` | Full project audit: narrow + broad lenses, triage, interactive fixes |
| `/decruft <target>` | Remove historical cruft from files |
| `/commit-push-check` | Lint (Rust: clippy/fmt), commit, push, verify CI green |
| `/doc-conv <document>` | Interactive conversation about a document |
| `/new-session` | Orient on project status and pick next work |

## Update

```bash
pi update
```
