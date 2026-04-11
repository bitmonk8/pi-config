# pi-config

Personal [pi coding agent](https://github.com/badlogic/pi-mono) configuration.

## Install

```bash
pi install git:git@github.com:bitmonk8/pi-config
```

## What's Included

### Extensions

- **subagent** — Delegate tasks to specialized subagents with isolated context windows. Supports single, parallel, and chained execution.

### Agents

Agent definitions used by the subagent extension (placed in `agents/`):

| Agent | Model | Purpose |
|-------|-------|---------|
| worker | Sonnet | General-purpose, full tool access |
| scout | Haiku | Fast codebase recon |
| planner | Sonnet | Implementation planning (read-only) |
| reviewer | Sonnet | Code review |

### Prompt Templates

| Command | Workflow |
|---------|----------|
| `/implement <task>` | scout → planner → worker |
| `/scout-and-plan <task>` | scout → planner |
| `/implement-and-review <task>` | worker → reviewer → worker |

## Update

```bash
pi update
```
