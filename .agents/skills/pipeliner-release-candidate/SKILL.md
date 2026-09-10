---
name: pipeliner-release-candidate
description: Build or prepare and verify the exact review or native candidate required by the configured release strategy without crossing the Production gate.
---

# Release a Candidate

Read `AGENTS.md`, `pipeliner.config.json`, the active Issue, pull request, configured release environments, and [release strategy reference](references/strategies.md).

1. Require a clean committed pull-request head, successful configured quality checks, In Progress status, and complete agent review.
2. Select only the procedure matching `release.strategy`. Ask the PM if the profile and real topology disagree.
3. Run configured builds locally on a compatible host, then the authorized review deploy and verification commands. Never build an application, native package or container image in Actions, including via setup/quality/reusable commands. Never substitute guessed commands or a different host. Follow [local QA execution](../pipeliner-work-issue/references/local-qa.md); independent QA turns and cleanup gates apply regardless of release strategy, and missing required hosts remain pending.
4. Record every candidate-identity component from authoritative sources; do not infer an artifact digest from a local image identifier.
5. Verify application behavior, health, readiness, restarts, logs, events, deployment controller state, and broader platform health in proportion to the configured environment.
6. Record the previous known-good target and clean only test processes, temporary artifacts, containers, images, or workspaces created by this run.
7. Return to `pipeliner-review-issue` with exact identity, evidence, limitations, and change-specific PM Testing steps.

Never merge, modify Production, reuse a stale approval, or invent access from this skill.
