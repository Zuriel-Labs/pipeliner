---
name: pipeliner-work-issue
description: Start or resume one Issue, recommend ready work for explicit PM selection when unspecified, and lead implementation through review to the next required PM gate.
---

# Work an Issue

Apply the shared [installed repository home](../pipeliner-maintain/references/home.md) and [message-only questions](../pipeliner-maintain/references/questions.md) contracts. First adoption retains its explicit-target gate. When an answer is needed, ask in the final ordinary message and end the turn immediately; no work or tool calls follow until the Human replies.

Follow [Issue-based communication](../../../AGENTS.md#issue-based-communication): lead progress, blockers, and handoffs with the selected Issue number and its current gate. Include the linked pull request and checks as supporting evidence; publishing or merging it does not complete the Issue.

Read `AGENTS.md`, `pipeliner.config.json`, the live Project and active cards, open Issues and pull requests, Git state, selected Issue, relevant code, tests, specifications, and history.

## Selection gate

- If more than one Issue is active, or the baton and lane conflict, remain read-only and report the exact repair needed.
- If one Issue is active, continue only that Issue. A different requested Issue must wait unless the PM first pauses or cancels the active work.
- With no requested or active Issue after a start/work request, list up to three highest-priority ready Backlog recommendations using configured priority option order, then lowest Issue number. Verify dependencies and readiness; ask the PM to select one explicitly before starting. Never auto-select from the list. Follow [lifecycle routing](references/lifecycle.md), including message-only questions and indefinite waiting without timers. A read-only audit does not authorize work selection.
- Treat In Progress, exact native Pending Review, and In Review as active. Require one active Issue and one sole assigned Agent Dev per repository/Project across environments. If Pending Review is not an exact native Project mapping, block circulating adoption/handoff rather than inventing a status.
- After baton handoff, the outgoing Dev is read-only. Resume that Dev only after the Issue is assigned back to the same accountable login and the Project card is read back in exact Pending Review.
- A requested Issue must be open and Backlog unless it is the active Issue. Resume On Hold only on explicit PM direction.

## Execute

1. Move the selected card to the configured In Progress status, assign the current Agent Dev's accountable GitHub login, and immediately read back metadata and the active count before code edits. The current Issue/Project and repository-local profile are canonical; no global or cross-repository mutable pipeline state may override them.
2. Resolve the Issue's base and integration target through the [release-cycle contract](../pipeliner-maintain/references/release-cycle.md) when configured; otherwise use the current default branch. Use the configured branch pattern. Isolate the work when needed and preserve user-owned changes.
3. Diagnose first. For medium or larger work, create or update the specification, plan, tasks, acceptance criteria, non-goals, risks, and verification commands before implementation.
4. Implement the smallest coherent outcome test-first. Keep scope and metadata current; obtain PM approval before materially changing the Issue body or product outcome.
5. Run focused checks while iterating and every configured quality command locally before publication. Follow [local QA execution and baton](references/local-qa.md) for environment ownership, full suites and cleanup. Commit the candidate and prepare required artifacts before requesting PM Testing; review owns that candidate-bound handoff. A missing host stays pending. No application/native/image builds in Actions, including indirect command chains; inspect the CI review ledger before publishing workflow changes. Record anything not run and why.
6. Commit intended files, push the focused feature branch, and create or update one pull request targeting the verified phase branch (default branch for a simple release). Use the configured Issue reference and no auto-close keyword. The PR-ready exact candidate is the Showcase target.
7. Invoke `pipeliner-review-issue` yourself and continue to the next actual PM gate. Do not stop merely because the PR exists or ask the PM to trigger review again. A pull request does not move the Issue to In Review by itself. PM feedback returns to the same Issue and candidate branch for fixes, fresh candidate verification and renewed approval. Only the approved exact PR may be merged; closing the Issue follows verified merge and the configured completion gate. Do not start a subsequent Issue unless the PM explicitly calls for it.

If the PM pauses work, move it to On Hold, preserve durable evidence, verify the slot is free, and stop implementation.
