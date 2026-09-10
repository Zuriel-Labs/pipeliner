# Conditional bootstrap checklist and migration

Use [message-only questions](../../pipeliner-maintain/references/questions.md). Read repository evidence and saved answers first. Mark each checklist item resolved, unresolved or not applicable with its reason in the existing target-owned decision record; persist confirmed configuration in the target profile. Do not manufacture names, topology, approval phrases or commands. Ask only applicable unresolved questions and preserve answers across sessions and repeated adoption.

| Condition | Resolve before dependent mutation |
|---|---|
| First adoption | Explicit target location or new-repository intent; verify local root and fetch/push repository identity. |
| Creating a repository | Name, purpose, owner, explicit visibility and local destination; verify access and absence. |
| Every adoption | Repository/Project identity, fields, visibility, active work, existing governance, quality commands and provider discovery. |
| Protection choice missing | Ask whether branch protection is wanted; preserve existing controls. If enabled, resolve branch scope and exact rules; removal requires explicit direction. |
| Application/runtime QA | Application type, runtime OS/architectures, compatible available hosts, dependencies, fixtures/accounts, ports, readiness, full setup/suite/teardown and cleanup ownership. |
| Participants | Explicit Agent Dev IDs with `kind=agent`, accountable `github` logins and environments; explicit Human PM IDs with `kind=human` in `qa.pms`; ordered turns pairing developer/environment/PM with exact approval phrases; `qa.mode=circulating`. Cover every participating Dev and PM and every required QA environment; explicitly list required Dev/environment combinations as turns. Available environments describe capabilities; they do not require a turn for every accessible Dev/environment combination. Several pairs may share a PM. |
| Delivery | Choose actual release strategy and destinations, pre-release/final identity, verification, rollback and authorization. A tooling repository may use `none`; never invent an application environment. |
| Staged delivery requested or evidenced | Confirm whether optional `release.cycle` is intended; if so resolve ordered phase IDs/kinds/branches/environments, readiness, phrases, promotion identity, forward-port destinations, target/milestone and Release Issue governance, freeze and aggregate all-pair/all-PM gates. Otherwise retain the simple Issue loop. |
| Native or container tests | Compatible local build host, platform-specific artifacts and exact resource inventory/cleanup. Missing hosts remain pending. No application builds in Actions. |
| Monitoring explicitly requested | Resolve supported scheduler, target/channel, cadence/timezone and notification preferences through the monitor skill; adoption alone never schedules. |

## Legacy compatibility is not consent

Version 1 profiles and legacy linear evidence remain readable for historical inspection. Missing `qa`, explicit Agent/Human kinds, PM roster, accountable GitHub identities or circulating mode requires discovery and explicit migration before a new QA sequence or adoption/update application. Do not infer a Human from an Agent login, duplicate a person to fill coverage, or reinterpret old approvals as a new pair's approval.

Prepare migration from confirmed saved answers, preserving repository/Project identity, custom commands, release settings and stronger local policy. Review differences and validate the resolved profile. Use the reviewed migration tooling only for fields it actually supports; do not claim a legacy helper automatically adds newly required fields. Preserve old records as historical evidence and begin new circulating records with explicit rounds/current turn; never synthesize passes. Optional cycle adoption also needs explicit resolved topology, not default phases added during an update.

Bootstrap/update testing remains Agent-owned: validate installation, home resolution, routing, provider links, repeated/customized adoption, target suites and cleanup. Configure future Human PM turns without starting them, requesting a bootstrap Showcase approval, or waiting for PM Testing/acceptance. Material unanswered configuration choices and existing repository protections still apply.
# Approval wording and outcomes

Set every workflow, QA-turn, release-environment and phase approval phrase to exactly `Approved`. This is the official response, not an interview choice. Discover which distinct environments, readiness decisions and PMs need approval; describe each gate's scope and outcome in its Showcase. The final QA approval includes integration/closure when no distinct release-stage testing remains. Do not create a second administrative completion gate. Preserve legacy evidence verbatim and reconcile only future requests and profile wording during adoption/update.
