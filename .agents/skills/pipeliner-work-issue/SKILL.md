---
name: pipeliner-work-issue
description: Select, reserve, specify, implement, validate, and publish one GitHub Issue while enforcing the configured single-active-Issue lifecycle.
---

# Work an Issue

Read `AGENTS.md`, `pipeliner.config.json`, the live Project and active cards, open Issues and pull requests, Git state, selected Issue, relevant code, tests, specifications, and history.

## Selection gate

- If more than one Issue is active, or the baton and lane conflict, remain read-only and report the exact repair needed.
- If one Issue is active, continue only that Issue. A different requested Issue must wait unless the PM first pauses or cancels the active work.
- With no requested or active Issue, rank the top three ready Backlog Issues and wait for PM selection.
- A requested Issue must be open and Backlog unless it is the active Issue. Resume On Hold only on explicit PM direction.

## Execute

1. Move the selected card to the configured In Progress status, assign the configured PM or repository baton owner, and immediately read back metadata and the active count before code edits.
2. Start from the current default branch using the configured branch pattern. Isolate the work when needed and preserve user-owned changes.
3. Diagnose first. For medium or larger work, create or update the specification, plan, tasks, acceptance criteria, non-goals, risks, and verification commands before implementation.
4. Implement the smallest coherent outcome test-first. Keep scope and metadata current; obtain PM approval before materially changing the Issue body or product outcome.
5. Run focused checks while iterating and every configured quality command locally before handoff. Follow [local QA execution and baton](references/local-qa.md) for explicit environment ownership, full suites, incoming pickup, cleanup and candidate-bound evidence. A missing host stays pending. No application/native/image builds in Actions, including indirect command chains; inspect the CI review ledger before publishing workflow changes. Record anything not run and why.
6. Commit intended files, push the focused branch, and create or update one pull request targeting the default branch. Use the configured Issue reference and no auto-close keyword.
7. Hand off to `pipeliner-review-issue`. A pull request does not move the Issue to In Review by itself.

If the PM pauses work, move it to On Hold, preserve durable evidence, verify the slot is free, and stop implementation.
