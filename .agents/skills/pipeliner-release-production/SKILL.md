---
name: pipeliner-release-production
description: Release the exact approved candidate to Production using the configured strategy, verify it, and recover safely on failure.
---

# Release Production

Follow [Issue-based communication](../../../AGENTS.md#issue-based-communication): acknowledge approval for the owning Issue, configured release gate, and exact candidate. Report release results and remaining PM Testing against that Issue, with pull-request and deployment evidence as supporting details. Preserve the configured approval phrase.

Read `AGENTS.md`, `pipeliner.config.json`, the active Issue, approved candidate evidence, merged pull request when required, current Production state, and the matching section of [release strategies](../pipeliner-release-candidate/references/strategies.md).

1. Require a configured Production destination; none/native-only strategies skip this skill. Revalidate the actual configured Production approval against pre-release identity, pull-request state, exact reviewed tree, checks and environment immediately before mutation. Link a resulting merge commit to the approved head/tree explicitly. Require all configured local QA turns and cleanup complete; [QA ownership](../pipeliner-work-issue/references/local-qa.md) is independent of deployment topology. Do not require future deployment IDs or interpret completion wording as pre-deployment acceptance. Do not create an artificial staging gate for direct Production.
2. Record the current known-good Production source, artifact, configuration, deployment revision, data backup or integrity evidence, and non-destructive rollback procedure.
3. For immutable promotion, prove Production receives the approved review digest without rebuilding. For direct Production, deploy the exact clean default-branch revision. For multi-environment, require all configured candidate validations before integration or release.
4. Use only configured build, promotion, deployment, and verification commands and the repository's declared source of truth. Application/native/image builds execute locally, never in Actions or transitive setup/quality workflows. Never make an imperative live edit the durable fix.
5. Record the actual final `release.candidateIdentity` and its continuity from approved source/tree/artifact. Verify migrations, application health/readiness, restart counts, logs/events, service behavior, deployment controller state, and relevant platform health. Unknown final identity blocks completion.
6. If verification fails, execute only the documented non-destructive rollback and verify recovery. Stop for PM authorization before destructive schema or data restoration.
7. Record concise release evidence in the existing Issue or pull request and resume `pipeliner-close-issue` yourself with numbered post-release PM Testing steps and the completion phrase for the final candidate. Keep In Review until actual acceptance; no repeated review trigger is needed. Feedback follows the same Issue's merged-PR remediation route.

Production health does not equal PM acceptance. Do not close the Issue from this skill.
