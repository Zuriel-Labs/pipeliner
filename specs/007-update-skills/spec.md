# Pipeliner update and optional monitoring skills

## Scope and acceptance

Ship `pipeliner-update` for explicitly requested framework updates in an identified adopter and `pipeliner-monitor-updates` for explicitly requested scheduled detection when the host supports persistent automations. Both are canonical portable skills with provider adapters and UI metadata, copied by existing adoption tooling.

Updates must resolve upstream identity and an immutable revision, inspect differences, preserve adopter configuration and custom policies, reconcile safely, validate locally, publish and verify. Per explicit PM direction, updates and monitor setup/management are direct maintenance: no GitHub Issue, active-slot reservation, Project movement, or Issue-creation/completion approval. Existing repository protections still apply; use a supporting PR only when required. Installing changes does not imply application deployment or unrelated Issue completion. Distinguish applied source provenance from observed upstream state; unknown provenance is never current. Existing adopters need no guessed version migration.

Monitoring must require a user request, an explicit target, schedule/timezone and an available persistent scheduler. Inspect existing jobs to avoid duplicates, use current tool schemas, read back saved state, keep unchanged successful checks quiet, and report meaningful updates or actionable failure. It must not install updates, create Issues, deploy, change credentials, or create an unsupported scheduler workaround. A request to build these skills does not authorize scheduling a monitor now.

## Plan

1. Write concise skills with a shared upstream/provenance reference and a reusable monitor prompt contract.
2. Wire routing into AGENTS.md, adoption and maintenance skills, README, and the Dark Mode policy. Add regular-file Claude adapters and OpenAI UI metadata.
3. Exercise fresh and repeated adoption, canonical links and provider metadata, and realistic update/monitor decision scenarios. Run changed-skill validation and the complete repository gate.
4. Publish the reviewed bootstrap changes, verify GitHub default-branch files and checks, and clean up task-owned validation resources.

## Verification scenarios

- Explicit current-repository update with custom policies: resolve upstream, keep local profile, preview/reconcile, publish verified maintenance without creating an Issue, record exact applied revision.
- Another Issue is active: preserve its work and isolate maintenance as needed; do not reserve or move its card, create an update Issue, or require an Issue-completion phrase.
- Legacy adopter without provenance: inspect history; if inconclusive, report unknown and compare content without inventing an installed SHA.
- Local edits or retired upstream files: preserve unknown edits; a missing upstream file does not authorize deletion.
- Upstream moves mid-update: finish only against the pinned reviewed commit, not a new branch head.
- Requested weekly monitor with scheduler: inspect existing jobs, resolve schedule/timezone, create or update one detection-only job and read back its prompt and state.
- Unsupported scheduler, missing schedule, or unavailable upstream: explain the limitation or ask for missing data; do not pretend scheduling or detection succeeded.
- Unchanged upstream, divergent history, repeated update, and check failure: suppress unchanged successful notifications, distinguish divergence from a newer revision, notify once per new revision or changed actionable failure, and report recovery without changing the applied baseline.

## Non-goals and risks

No automatic scheduling during adoption; no background detection infrastructure, application changes, schema migration, or new provider SDK. Tool schemas are discovered at execution time to avoid embedding stale APIs. Source records are evidence maintained by the agent, not cryptographic proof of semantic equivalence. Existing instruction files are conflict-reviewed, never blindly overwritten.
