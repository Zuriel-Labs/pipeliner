---
name: pipeliner-configure
description: Guide a repository-local Human PM and Agent Dev configuration discussion, persist only explicit agreements, and report readiness gaps.
---

# Configure a Repository Pipeline

Use this skill when a repository needs to establish or revisit its local Pipeliner configuration. It is an agent-runtime-agnostic entry point for a bounded discussion between the Human PM and Agent Dev; it does not configure another repository, a home-level installation, credentials, providers, or deployment state.

## Authority and isolation

1. Verify the target repository identity, real Git root, `AGENTS.md`, `pipeliner.config.json`, schema, canonical skills, GitHub Issues and linked GitHub Project. Read current local and live evidence before asking questions.
2. Bind the interview, outstanding questions, explicit agreements, proposed edits and readiness result to that repository identity. Reusable templates are proposals only; never import another repository's choices automatically.
3. Preserve unknowns as unresolved. Do not infer a Human PM from a login, a Dev from an operating system, an environment from a channel name, or infrastructure from a phase name.

## Compact guided configuration

Inventory first, then present only unresolved decisions grouped by their owner. The minimum configuration surfaces are:

- **Roles and topology:** explicit Agent Dev identities and accountable logins, Human PM identities, ordered Dev/environment/PM QA turns, and the allowed number of participants/environments.
- **Canonical work system:** GitHub Issues plus the linked GitHub Project, exact Status and metadata mappings, one active Issue and one active Dev, and assignment/Project readback rules.
- **Lifecycle:** feature branch, linked PR, exact candidate Showcase, same-Issue PM feedback/fix loop, exact approval, merge, verified Issue closure, and an explicit PM call before another Issue.
- **Release channels:** repository-local `channelPlan`; default `Canary -> Alpha -> Canary -> Beta -> Stable`, optional omission of Alpha/Beta, optional PM-configured extra Canary before Stable, mandatory Stable, and no direct development write into Stable.
- **Infrastructure agreement:** explicit PM/Agent agreement for build method, QA environments and release destinations as independent concerns. Preserve existing verified commands; do not invent or substitute providers.

Ask message-only questions only for unresolved material choices. Show the proposed configuration delta in the repository's profile vocabulary, including unknowns and the exact readiness consequence, before writing anything.

## Persistence and readiness

- Persist only an explicit PM agreement and its Agent Dev readback in repository-local configuration/state. Keep evidence concise and secret-free.
- Run profile/schema validation and deterministic contract checks after a proposed edit. Do not run application builds, deploys, service operations, provider calls or ordinary generation tests as part of this skill.
- Missing GitHub Issues/Project integration, missing native Pending Review mapping, ambiguous Agent/Human identity, incomplete QA topology, invalid channel path, or missing infrastructure agreement blocks only the affected lifecycle/release action. Planning and offline contract tests may continue.
- A Goal may be an optional runtime execution aid. It never replaces the Issue/Project, carries the baton, or authorizes acceptance, merge, closure or release.

## Handoff

End with a repository-bound configuration summary: verified identity, explicit agreements, unresolved questions, proposed file changes, readiness gates, and what was not run. Do not apply live Project/Issue changes or begin application work from a configuration discussion.
