---
name: pipeliner-pipeline-health
description: Perform a read-only audit of repository, Issue, Project, pull-request, check, candidate, deployment, and runtime pipeline health.
---

# Audit Pipeline Health

Follow [Issue-based communication](../../../AGENTS.md#issue-based-communication): organize work-status findings by owning Issue and its remaining gates, including linked pull-request, check, and deployment evidence. Report unlinked pull requests or missing Issues explicitly without substituting PR numbers for Issue identity.

Read `AGENTS.md`, `pipeliner.config.json`, and [Project operations](references/project-operations.md).

1. Run `node scripts/validate-repository.mjs` from the repository root.
2. Run `node scripts/audit-project.mjs --config <absolute-config-path>` when a live Project number is configured.
3. Inspect Git branch, head, dirty state, remote default branch, open Issues, active cards, open pull requests, linkage, reviews, checks, assignments, and exact candidate records.
4. When runtime health is requested, use only configured read-only verification commands and distinguish application, environment, deployment, and broader platform health.
5. Report each layer separately, identify exact drift and evidence limits, name the owning skill or PM decision required, and state that no changes were made.

Never repair Project fields, Issues, pull requests, Git, artifacts, deployments, or runtime state from this skill.
