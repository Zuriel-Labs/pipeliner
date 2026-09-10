---
name: pipeliner-audit-backlog
description: Audit and, when explicitly requested, repair Backlog Issue classification without consuming the active work slot.
---

# Audit the Backlog

Apply the shared [installed repository home](../pipeliner-maintain/references/home.md) and [message-only questions](../pipeliner-maintain/references/questions.md) contracts. First adoption retains its explicit-target gate.

Follow [Issue-based communication](../../../AGENTS.md#issue-based-communication): lead each finding, recommendation, and status with the Backlog Issue number. Include linked pull requests as supporting evidence and distinguish delivered implementation from an Issue that has passed all completion gates.

Read `AGENTS.md`, `pipeliner.config.json`, the live Project schema, every Backlog Issue, open pull requests, and relevant repository or dependency evidence.

- Account for every Backlog Issue and classify it as ready, blocked, dependent, duplicate, superseded, delivered, or needing PM clarification.
- Verify each is open, inactive, normally unassigned, has one governed type, applicable areas, and complete configured Priority, Impact, and Effort fields.
- Rank ready work by security, privacy, data integrity, release reliability, user impact, dependency value, urgency, readiness, risk, and effort. Reserve P0 for genuinely urgent blockers.
- Default to read-only reporting. Apply Backlog-only metadata repairs only when the PM explicitly requests correction; never change scope, body, status lane, or active work without the corresponding workflow authority.
- Read every permitted mutation back and report before/after values with evidence. Report a no-op audit plainly.
- If no Issue is active, recommend the top three ready outcomes and wait for PM selection. Do not start one from this skill.

When `release.cycle` is configured, follow [release scope and phase governance](../pipeliner-maintain/references/release-cycle.md): inspect target/milestone, Release Issue, phase, freeze and blockers without treating phase as Status. Read-only inspection never starts or advances a cycle. Related findings stay on the same Issue; unrelated intake requires exact draft approval.
