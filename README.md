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

### Prompt Templates

| Command | Description |
|---------|-------------|
| `/review [target]` | Run 9 review lenses in parallel on changes (default: uncommitted) |
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
