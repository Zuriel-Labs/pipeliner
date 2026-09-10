---
name: pipeliner-review-issue
description: Review or resume the active Issue, remediate feedback before or after merge, and guide its exact candidate through the next PM gate.
---

# Review an Issue

Follow [Issue-based communication](../../../AGENTS.md#issue-based-communication): identify the Issue first in findings, PM Testing handoffs, approval requests, and approval acknowledgments. Bind the configured approval to that Issue and exact candidate, retaining the pull request as review evidence.

Read `AGENTS.md`, `pipeliner.config.json`, the sole active Issue, complete pull-request diff and history, acceptance criteria, specifications, candidate state, and applicable test guidance.

1. Require the sole active Issue in In Progress or In Review and matching supporting PR evidence with the configured non-closing Issue reference. Follow [lifecycle routing](../pipeliner-work-issue/references/lifecycle.md). An open PR proceeds through review; a merged PR without findings resumes pending release verification/acceptance instead of requiring another open PR. A merged PR with findings returns the same Issue to In Progress and uses a fresh remediation branch/PR from the current default branch.
2. Review correctness, regressions, security, privacy, authorization, data integrity, errors, concurrency, migrations, operations, accessibility, responsive UX, performance, compatibility, documentation, and tests in proportion to the change.
3. Run focused tests, every configured quality command locally, diff checks, migration rehearsal, security checks, and hands-on application testing where applicable. Review all Actions transitive chains and CI review freshness; application/native/image builds stay local. Follow [local QA execution](../pipeliner-work-issue/references/local-qa.md); agent review and preparation precede PM approval and do not require that approval as an entry condition.
4. Remediate every finding on the current supporting branch (a fresh branch after merge). Repeat affected review and tests until no unresolved finding remains.
5. For an open PR, confirm it is current, mergeable, and green for the exact committed head. Record source identity now; record artifact/environment identity when actually produced. Do not require future deployment identity at this stage.
6. If a required review/native candidate has not already been prepared and verified for this exact source, invoke `pipeliner-release-candidate`; otherwise reuse its verified evidence. For none/direct-production, prepare the local candidate directly. Evaluate ordered QA turns and present the next turn's PM Testing steps and configured approval. Keep In Progress while any turn, host pickup or cleanup is pending. After a PM reply, own cleanup, readback and continuation without another trigger.
7. Move to In Review only after the applicable candidate and every configured QA turn are verified and cleanup is complete; immediately read back the card and active count. Follow the strategy's ordered gates. For none request completion approval; for direct-production request Production authorization against pre-release identity; immutable/native gates use their prepared artifact/environment. Do not ask for acceptance of an undeployed Production candidate.
8. Present user-friendly numbered PM Testing steps following [the PM Testing contract](references/pm-testing.md), limited to the actual next gate. Put the exact configured phrase in its own fenced code block. On actual approval, revalidate identity and invoke `pipeliner-close-issue` for the next authorized merge/release/close transition. Questions use native controls where permitted or a clearly marked message and wait indefinitely without timers.

PM findings are blocking. Move the Issue back to In Progress before remediation, create a new candidate, and repeat affected gates. Silence and earlier approval are not acceptance.
