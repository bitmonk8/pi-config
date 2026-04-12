---
description: Remove historical cruft from files
---
Remove all historical cruft from $@.

Historical cruft is anything that references already-completed work rather than current or future state. Examples:

- Changelog entries, decision logs, or history sections describing past milestones
- Comments referencing resolved bugs, closed tickets, or completed tasks
- "Previously deferred" / "since implemented" / "was X, now Y" narrative
- Checked-off checklist items (e.g., `- [x] ...`)
- Sections like "Decisions Made", "History", "What changed" that exist solely as a record of the past
- Dead code left behind with "removed X" or "replaced by Y" comments
- References to old approaches, migrations, or refactors that are already done
- Version/date stamps on individual changes within a document

What to preserve:

- Current state, active work items, and forward-looking plans
- Unchecked checklist items (pending/future work)
- Design rationale that explains WHY the current design exists (but strip the historical narrative of HOW it got there)
- Any content that is still actionable or informative for someone encountering the project today

Process:

1. Read the specified input thoroughly.
2. Identify all historical cruft.
3. Present a summary of what will be removed (grouped by category) and ask for confirmation before making changes.
4. On confirmation, apply the changes. For documents, rewrite sections cleanly rather than leaving gaps. For code, remove dead references without breaking functionality.
