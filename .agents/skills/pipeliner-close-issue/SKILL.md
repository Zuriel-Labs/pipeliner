---
name: pipeliner-close-issue
description: Complete an active Issue only after exact-candidate release evidence and every configured PM Testing approval gate are current.
---

# Close an Issue

Follow [Issue-based communication](../../../AGENTS.md#issue-based-communication): request and acknowledge completion for the owning Issue and exact candidate. Render the configured completion phrase with the Issue number, never the pull-request number; the default is `Approved to complete Issue #{number}`. Lead the final status with the Issue and report it complete only after every gate and live readback pass. Retain the linked pull request as supporting evidence.

Read `AGENTS.md`, `pipeliner.config.json`, the sole active Issue, matching pull request, candidate record, current PM approval, checks, release evidence, and live Project state.

1. Require In Review, successful configured gates, zero unresolved findings, stage-appropriate identity and the actual approval required next by the [release strategy](../pipeliner-release-candidate/references/strategies.md). Verify every local QA turn, exact PM approval and final cleanup using [local QA execution](../pipeliner-work-issue/references/local-qa.md). Pending turns return to review in In Progress; never invent completed turns or require an undeployed candidate's final identity before merge.
2. For none, the configured completion approval authorizes exact-tree merge and closure after readback. For strategies with Production, require configured Production authorization before merge/deploy; native-only integration requires configured native approvals. Bind the approval to the pre-release candidate and use the exact head when merging. Verify the resulting default-branch tree equals the reviewed tree and record the resulting source commit. Stop on mismatch; unrelated changes require fresh QA/approval.
3. Invoke `pipeliner-release-production` yourself only when a configured Production destination is not yet verified. Skip it for none and native-only releases; verify source or native publication through the declared procedure instead. Do not rebuild an immutable candidate.
4. For released application/native candidates, keep the Issue open and In Review until change-specific final PM Testing and the exact configured completion approval cover the final identity. For none, the pre-merge completion approval remains valid only for the verified exact-tree integration in step 2. Do not ask the PM to repeat a completed gate for the same unchanged candidate.
5. Re-read applicable source, tree, artifact, deployment, approvals, Issue, card, and health immediately before completion. Unexpected identity change invalidates approval. Record the intended merge/deployment transition without transferring approval to a different tree or artifact.
6. Only after every configured gate passes, add concise evidence to the Issue or pull request, close the Issue, move its card to Done, clear assignment when policy requires it, delete the merged branch when safe, and read everything back.
7. Verify zero active Issues and report the outcome with regression steps appropriate to the actual source/native/Production target. Do not invent Production for none or create a duplicate acceptance report. Do not start another Issue without a request.

A merged pull request or healthy deployment alone is never completion.
