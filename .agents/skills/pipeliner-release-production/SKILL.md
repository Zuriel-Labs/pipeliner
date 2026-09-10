---
name: pipeliner-release-production
description: Release the exact approved candidate to Production using the configured strategy, verify it, and recover safely on failure.
---

# Release Production

Read `AGENTS.md`, `pipeliner.config.json`, the active Issue, approved candidate evidence, merged pull request when required, current Production state, and the matching section of [release strategies](../pipeliner-release-candidate/references/strategies.md).

1. Revalidate the approval phrase, candidate identity, pull-request state, exact tree, required checks, environment, and authorization immediately before mutation. Require all configured local QA turns and cleanup to be complete for the shared candidate; [QA ownership](../pipeliner-work-issue/references/local-qa.md) is independent of deployment topology. Do not create an artificial staging gate for direct Production.
2. Record the current known-good Production source, artifact, configuration, deployment revision, data backup or integrity evidence, and non-destructive rollback procedure.
3. For immutable promotion, prove Production receives the approved review digest without rebuilding. For direct Production, deploy the exact clean default-branch revision. For multi-environment, require all configured candidate validations before integration or release.
4. Use only configured build, promotion, deployment, and verification commands and the repository's declared source of truth. Application/native/image builds execute locally, never in Actions or transitive setup/quality workflows. Never make an imperative live edit the durable fix.
5. Verify exact identity, migrations, application health/readiness, restart counts, logs/events, service behavior, deployment controller state, and relevant platform health.
6. If verification fails, execute only the documented non-destructive rollback and verify recovery. Stop for PM authorization before destructive schema or data restoration.
7. Record concise release evidence in the existing Issue or pull request and return to `pipeliner-close-issue` or `pipeliner-review-issue` with numbered PM Testing steps.

Production health does not equal PM acceptance. Do not close the Issue from this skill.
