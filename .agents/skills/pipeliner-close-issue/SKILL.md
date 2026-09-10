---
name: pipeliner-close-issue
description: Complete an active Issue only after exact-candidate release evidence and every configured PM Testing approval gate are current.
---

# Close an Issue

Follow [Issue-based communication](../../../AGENTS.md#issue-based-communication): request and acknowledge completion for the owning Issue and exact candidate. Render the configured completion phrase with the Issue number, never the pull-request number; the default is `Approved to complete Issue #{number}`. Lead the final status with the Issue and report it complete only after every gate and live readback pass. Retain the linked pull request as supporting evidence.

Read `AGENTS.md`, `pipeliner.config.json`, the sole active Issue, matching pull request, candidate record, current PM approval, checks, release evidence, and live Project state.

1. Require In Review, exact current candidate identity, successful configured gates, zero unresolved findings, and the approval required at this point by the selected release strategy. Verify every configured independent local QA turn, exact PM approval and final task-owned cleanup using [local QA execution](../pipeliner-work-issue/references/local-qa.md). Missing hosts, waiting pickup and PM-retained resources are pending, not complete. Legacy missing QA requires discovery before a new sequence; do not invent completed turns.
2. If merge precedes Production, record the approved head tree, merge using the repository's approved method, and prove the resulting default-branch tree equals the reviewed tree. Stop on mismatch.
3. Invoke `pipeliner-release-production` when Production is not yet verified. Do not rebuild an immutable candidate.
4. For direct Production, keep the Issue open and In Review after deployment until the PM completes Production PM Testing and gives the exact configured completion phrase for the unchanged release.
5. Re-read source, tree, artifact, deployment, approval, Issue, card, and health immediately before completion. Any candidate change invalidates approval.
6. Only after every configured gate passes, add concise evidence to the Issue or pull request, close the Issue, move its card to Done, clear assignment when policy requires it, delete the merged branch when safe, and read everything back.
7. Verify zero active Issues and report the outcome with numbered Production regression steps. Do not create a duplicate acceptance report unless requested.

A merged pull request or healthy deployment alone is never completion.
