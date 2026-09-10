---
name: pipeliner-review-issue
description: Perform complete agent QA for the active Issue, remediate findings, identify the exact candidate, and prepare its PM Testing handoff.
---

# Review an Issue

Read `AGENTS.md`, `pipeliner.config.json`, the sole active Issue, complete pull-request diff and history, acceptance criteria, specifications, candidate state, and applicable test guidance.

1. Require one active In Progress Issue and one matching open pull request with the configured non-closing Issue reference.
2. Review correctness, regressions, security, privacy, authorization, data integrity, errors, concurrency, migrations, operations, accessibility, responsive UX, performance, compatibility, documentation, and tests in proportion to the change.
3. Run focused tests, every configured quality command locally, diff checks, migration rehearsal, security checks, and hands-on application testing where applicable. Follow [local QA execution](../pipeliner-work-issue/references/local-qa.md). Evaluate every required turn against the current candidate and verify PM approval and final cleanup before declaring that turn complete. While a turn awaits PM Testing or host pickup, hand it off clearly and keep In Progress; In Review requires completed QA turns. Review all Actions transitive chains and CI review freshness; application/native/image builds stay local.
4. Remediate every finding on the same branch. Repeat affected review and tests until no unresolved finding remains.
5. Confirm the pull request is current, mergeable, and green for the exact committed head. Record every configured candidate-identity component.
6. If the release strategy has a review or native environment, invoke `pipeliner-release-candidate`; otherwise prepare the local/CI candidate directly.
7. Move the Issue to In Review only after the candidate is verified, then immediately read back its card and the active count.
8. Present user-friendly numbered PM Testing steps following [the PM Testing contract](references/pm-testing.md). Put the exact configured approval phrase in its own fenced code block when approval is next.

PM findings are blocking. Move the Issue back to In Progress before remediation, create a new candidate, and repeat affected gates. Silence and earlier approval are not acceptance.
