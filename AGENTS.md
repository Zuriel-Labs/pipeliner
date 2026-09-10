# Pipeliner agent operating contract

This repository uses Pipeliner: an evidence-first, agent-managed development and release lifecycle. Read this file, `pipeliner.config.json`, and the relevant canonical skill under `.agents/skills/` before acting.

## Pipeliner adoption entrypoint

- Treat requests to install, bootstrap, adopt, or initially align Pipeliner in a repository as `pipeliner-adopt` work before applying the normal lifecycle to that target. Requests to update an existing adoption use `pipeliner-update`; changes to the upstream framework itself use `pipeliner-maintain`.
- Use `pipeliner-monitor-updates` only for explicitly requested scheduled update detection or management of an existing monitor. Discover supported persistent automation capabilities before creating a job; if unavailable, report that limitation. Neither adoption nor an update request authorizes scheduling, and detection never authorizes installation.
- Running `pipeliner-update` or `pipeliner-monitor-updates` is direct framework maintenance: do not create or require a GitHub Issue, reserve the active Issue slot, move Project cards, or request Issue-creation/completion approval. Execute the user's requested operation, preserving unrelated active work and existing repository protections. Use a supporting PR only when repository controls require it. Report the target repository, operation, and exact revision or automation identity; this is an explicit exception to Issue-based lifecycle and communication rules below.
- The target repository location is required for existing-repository adoption. Accept an absolute local checkout path, GitHub `OWNER/REPO`, GitHub repository URL, or an explicit statement that the current repository is the target. Explicit intent to create a new repository starts the creation interview.
- If both target and creation intent are omitted, ask one concise question: `What is the target repository location, or do you want to create a new repository?` Then wait before target or Project mutation. Do not guess a repository from the current directory, recent work, or chat history.
- For creation, resolve name, purpose, owner, explicit visibility and local destination before mutation. Verify absence and creation authority; authentication, permission, network failures and an ambiguous 404 are not proof of absence. Initialize the appropriate README and verify local/remote identity before adoption. Never inherit Pipeliner's public visibility.
- Use the [conditional bootstrap checklist](.agents/skills/pipeliner-adopt/references/discovery.md), preserving saved answers and asking only unresolved applicable questions. Configure future paired QA and optional cycles without imposing application PM gates on bootstrap/update.
- Once the target is explicit, read `.agents/skills/pipeliner-adopt/SKILL.md` and own its complete workflow. Verify exact local and remote identity before mutation and keep all authority bounded to that target repository and its linked Project.
- Adoption authority covers safe repository and Project alignment. It does not authorize application deployment, credential changes, destructive migration, or unrelated backlog work.
- Branch protection and repository rulesets are opt-in, never bootstrap defaults. Ask whether the PM wants them; record the explicit choice in `workflow.branchProtection`. If enabled, clarify branch scope and exact rules first. If omitted, preserve current controls and ask; do not infer consent from quality checks, Project setup or example repositories. Remove existing protection only on explicit PM direction. Agent quality checks and exact PM approval still apply without branch protection.

## Authority and source of truth

- Resolve an installed skill's own repository using [installed home verification](.agents/skills/pipeliner-maintain/references/home.md): canonical skill/profile root, real Git root, AGENTS.md and matching fetch/push origin identities. First adoption still requires an explicit target. Never infer auxiliary repositories.
- The repository-owned profile in `pipeliner.config.json` defines repository identity, Project fields, quality commands, release strategy, environments, candidate identity, and exact approval phrases.
- `AGENTS.md` is the canonical provider-neutral instruction source. Provider files import or point to it; do not duplicate this policy.
- `.agents/skills/` is canonical for workflow skills. Provider-specific skill folders contain regular-file adapters, never copied policy or symlinks.
- `.agents/pipeliner-policy.html` is the human-facing lifecycle reference. Keep it self-contained and in Dark Mode.
- Live repository, Issue, pull request, Project, check, artifact, deployment, and runtime state outrank chat memory and cached identifiers.
- Preserve unknown or user-owned changes. Never reset, restore, clean, stash, overwrite, commit, publish, or deploy them without explicit direction.

## PM and agent responsibilities

- Devs are Agents and PMs are Humans. Configure explicit Agent Dev identities and accountable GitHub logins, Human PM identities in `qa.pms`, and developer/environment/PM pairs in `qa.turns`; several pairs may share a PM. Never infer or invent participants.
- The Project Manager (PM) chooses product direction, resolves material ambiguity, performs Project Manager QA or PM Testing, reports findings, and grants exact-candidate approvals.
- Agents own normal research, specifications, implementation, tests, Project movement, GitHub coordination, releases, verification, readback, rollback within documented non-destructive authority, and concise closeout.
- When repository evidence cannot resolve a material choice, ask the PM focused clarifying questions, explain the tradeoff, and recommend a default when evidence supports one. Do not silently invent product behavior, release topology, acceptance criteria, credentials, or destructive recovery authority.
- Never ask the PM to perform routine Project bookkeeping the agent can perform and verify.

## Agent-led continuation and questions

- A request to start/work an Issue authorizes the agent to continue its implementation, review, verification and coordination through the next actual PM gate. Invoke the next canonical skill yourself; do not ask the PM to name skills, restart routine stages, run ordinary commands or move cards. After testing approval or feedback, revalidate the candidate and resume the appropriate stage. Preserve exact approval requirements and external controls.
- Honor the sole active Issue and an explicit requested Issue. With no active or specified Issue after a start request, select one ready open Backlog Issue by configured priority option order (highest first), then lowest Issue number; verify dependencies and readiness first. Ask only for unresolved material priority/readiness decisions. Read-only audits never start work. Completion of one Issue does not authorize starting another.
- Ask all questions only in ordinary agent messages marked `Question:`; never use native question controls or structured question tools. Follow [message-only questions and saved answers](.agents/skills/pipeliner-maintain/references/questions.md), including exact approval messages.
- Preserve answered questions. Wait indefinitely for required answers: no timers, timed reminders, silence-based defaults, or inferred approval. Pause only dependent work; continue independent authorized work. Do not schedule reminders. Tool wait timeouts are polling boundaries, not PM deadlines or permission to proceed.
- Follow [lifecycle routing](.agents/skills/pipeliner-work-issue/references/lifecycle.md) for resumed review, merged-PR feedback and stage-specific approvals. The pure helpers in `scripts/lib/lifecycle.mjs` check supplied decision inputs; they neither execute actions nor authenticate evidence.

## Pipeline invariants

- One GitHub Issue is the primary unit of work. Pull requests and branches are supporting evidence.
- Exactly one Issue may be active by default. Active means the configured In Progress or In Review status. On Hold is inactive and only the PM may request it.
- Before Issue or code work, inspect the live Project, every active card, open Issues, open pull requests, relevant checks, current branch and head, and selected Issue. Fail closed on missing access, conflicting state, or more than one active Issue.
- The agent moves Project cards and immediately reads back Status, metadata, assignment, Issue state, and the active count.
- Keep Status, Priority, Impact, Effort, labels, assignee, Issue state, branch, and pull request linkage coherent at each transition.
- A merge is not a release. A release is not PM acceptance. Automation must never mark work complete before the configured release and PM Testing gates.

## Issue-based communication

- Lead every work-status update, blocker, QA handoff, release report, approval request, approval acknowledgment, and completion message with the owning GitHub Issue number and its outcome or remaining gate. Use the Issue title when additional context helps.
- Keep pull requests critical supporting evidence: include their links or numbers, review/check results, merge state, and exact candidate identity where relevant. A pull-request number must never stand in for the Issue number or define whether the Issue is complete.
- Bind each approval to the owning Issue, the specific configured gate, and the exact unchanged candidate. The official response for every gate is exactly `Approved`. Put the Issue number, gate, candidate and authorized outcome in the surrounding request, not in the response. Never infer gate scope from identical phrase fields. Issue-based wording does not broaden approval or waive any gate.
- For example, when Issue #42 is implemented by PR #57, say “Issue #42 is In Progress; implementation is in PR #57,” or “Issue #42 is awaiting PM Testing; PR #57 is merged.” When final acceptance remains, request `Approved`, and acknowledge it for Issue #42 and the verified candidate. Say “Issue #42 is complete” only after all completion gates and live readback pass.
- If no Issue exists or its linkage is ambiguous, state that limitation and resolve it through the configured Issue workflow. Never invent an Issue number, substitute a PR number, or bypass Issue-creation approval.

## Canonical lifecycle

1. New work uses `pipeliner-create-issue`. Research duplicates and repository behavior, clarify unresolved intent, show the complete Issue and metadata, obtain the configured exact approval, create it in Backlog, and read it back.
2. Backlog analysis uses `pipeliner-audit-backlog` and does not start implementation.
3. Implementation uses `pipeliner-work-issue`. Reserve the single active slot, create the configured focused branch, work spec-first and test-first, run repository gates, push, and create or update a pull request that references rather than auto-closes the Issue.
4. Agent review uses `pipeliner-review-issue`. Review and remediate correctness, security, data integrity, operations, accessibility, UX, compatibility, and tests in proportion to the change.
5. Candidate release uses `pipeliner-release-candidate` only when the configured strategy has a review or native environment.
6. Production release uses `pipeliner-release-production` only for an actual configured Production destination, with the required authorization and candidate identity. A final cycle phase `kind=production` may instead be native Stable distribution; follow candidate/distribution verification and aggregate all-PM acceptance through review/close as defined in the shared cycle contract.
7. Completion uses `pipeliner-close-issue` only after release verification and the configured PM acceptance gate.
8. Read-only diagnosis uses `pipeliner-pipeline-health`. Changes to these contracts use `pipeliner-maintain`.
9. Updating an existing adoption uses `pipeliner-update`, preserving local policies and recording the reviewed upstream revision. User-requested monitoring uses `pipeliner-monitor-updates` only where a supported scheduler exists. These two operational workflows do not require GitHub Issues or consume the active Issue slot.

## Specification and implementation

- Research current code, tests, documentation, official primary sources, and live service state before designing a material change.
- For medium or larger work, create or update a written specification, implementation plan, ordered tasks, acceptance criteria, non-goals, risks, and verification commands before implementation.
- Use Red, Green, Refactor for behavioral logic. Keep increments small, coherent, reversible, and verified.
- Prefer repository-native commands and existing architecture. Do not weaken tests, authentication, authorization, validation, audit logging, security controls, accessibility, CI, or release checks to make work pass.
- Run every configured quality command and inspect exit status before claiming success. List anything not run and why.

## Optional release cycle

Follow the shared [release-cycle contract](.agents/skills/pipeliner-maintain/references/release-cycle.md) whenever `release.cycle` is configured. It governs phase branch routing, development-Issue integration acceptance, target/milestone and Release Issue scope, freeze, aggregate all-pair/all-PM QA, verified forward-ports and promotion identity. These rules take precedence over simple default-branch/Production-only routing below. Use the existing 12 skills; phase transitions are not Status changes or final release acceptance.

## Candidate and release contract

- QA topology is independent of release topology. Read explicit `qa.developers`, `qa.pms`, `qa.environments`, ordered `qa.turns` and `qa.mode=circulating`; follow [local QA execution](.agents/skills/pipeliner-work-issue/references/local-qa.md). Legacy profiles/evidence remain readable, but [explicit discovery and migration](.agents/skills/pipeliner-adopt/references/discovery.md) precede a new sequence.
- Build applications, native packages and container images only on compatible local hosts. No application builds may execute in GitHub Actions, including through setup, package hooks, quality scripts, composite actions or reusable workflows. Keep reviewed lightweight checks and inspect every transitive command before publishing workflows.
- Each required local turn runs the complete environment suite and records source/tree and all shared candidate identity, owner, environment, session, host, results, PM approval and cleanup. Missing hosts remain pending. QA waiting and pickup keep the sole Issue In Progress; only the PM can request On Hold. One developer/one environment omits the baton; self-handoff and same-OS handoff still require independent complete turns.
- The current Agent Dev/Human PM pair finishes on the latest candidate before circulation to the next stale pair in configured order, wrapping as needed. Candidate changes invalidate all prior shared QA, including documentation/evidence-only changes; retain history and use the latest round per turn, never an earlier pass after failure. All pairs must pass on the latest candidate. Pass only after outgoing review, suite, full Showcase, actual PM approval, cleanup and next-candidate availability are verified.
- Inventory task-owned processes, images, containers, volumes, workspaces and artifacts before local tests. Use exact IDs and run ownership; teardown in failure and success paths, inspect removal and report cleanup failures. Preserve unrelated resources. Record PM-retained resources with owner and cleanup trigger; never use global prune, broad process kills or inferred ownership.

- Record every configured candidate-identity component at its applicable stage. `release.preReleaseIdentity` identifies evidence available before merge/release approval; `release.candidateIdentity` identifies the final release. Both include source commit and Git tree. Never require or invent a future deployment ID before deployment. Follow the [release strategy reference](.agents/skills/pipeliner-release-candidate/references/strategies.md) for legacy discovery and defaults.
- Any unexpected change to a configured identity component invalidates prior PM approval. Re-run affected gates and request fresh approval. An approved exact-tree merge or same-artifact deployment produces a new stage record: verify and link its resulting commit/deployment identity to the approved source/tree/artifact. This permits only the intended transition, not an unreviewed tree or rebuilt artifact.
- `immutable-promotion`: build the exact review candidate once, verify it in the review environment, obtain exact PM approval, and promote the same immutable artifact to Production without rebuilding.
- `direct-production`: complete configured local QA, obtain the configured Production authorization for pre-release identity, merge the exact reviewed tree, deploy the exact clean default-branch revision, verify final identity and Production, then keep the Issue active until Production PM Testing and exact completion approval. Local QA approval is not Production acceptance.
- `multi-environment`: each configured environment validates the exact code candidate independently. Approval from one environment cannot stand in for another.
- Record a known-good rollback target before deployment. A documented non-destructive application or GitOps rollback may be agent-owned; destructive schema or data recovery always requires explicit PM approval.

## PM Testing handoff

### One approval per tested outcome

- For source-only (`none`) and native-only delivery without Production, the final required PM QA approval (such as `Approved`) also authorizes exact-candidate integration, verified publication, Issue closure and cleanup. Never request an additional Issue-completion approval for that same outcome. All configured pairs must approve the latest candidate first; intermediate approvals advance the baton only.
- The Showcase must explain this outcome before requesting approval. Continue automatically after approval through merge, verification, closure and cleanup; stop only for failed evidence, a changed candidate or an actual external control. Preserve original QA records and prove exact-tree/artifact continuity after integration.
- Production authorization, testing of a newly deployed environment, and release-phase readiness can be distinct decisions. Each final PM acceptance also authorizes its corresponding closure or phase transition; never append an administrative completion confirmation to an already approved final candidate. Existing completion phrase fields name a final acceptance gate where one exists, not a mandatory extra gate. This rule governs the default completion examples elsewhere in this contract.

`pipeliner-adopt` and `pipeliner-update` are exempt from PM Testing and PM acceptance. Do not request PM Testing steps, a PM test session, or a bootstrap-completion approval phrase. The agent runs the configured test suites and agent testing, remediates findings, reruns affected checks until clean, verifies publication and cleanup, then reports completion. Configure future application QA without starting or waiting for its PM turns during bootstrap. This exception overrides generic handoff/completion rules for these operations only; application development/release gates, material-choice clarification, and existing repository protections still apply.

Every Issue or aggregate release handoff includes the full [Showcase and PM Testing contract](.agents/skills/pipeliner-review-issue/references/pm-testing.md): summary, Agent findings (explicitly none when empty), test results, exact target and prerequisites, numbered action/expected-result steps, regressions, limitations, candidate, next outcome and configured approval phrase. Agent evidence never replaces Human PM acceptance. Feedback returns to the same Issue and current pair for remediation, fresh candidate verification and circulation.

## Repository commands and installed tooling

- Run the target's `quality.commands` and the current `qa.environments` setup, suite and teardown from `pipeliner.config.json`. Read its manifest/documentation for prerequisites; never assume a package manager or copy Pipeliner's own package scripts into another stack.
- Installed framework tools require Node.js 22 or later independently of the application's language: `node scripts/validate-repository.mjs`, `node scripts/audit-project.mjs --config <absolute-config-path>`, `node scripts/resolve-home.mjs` (no arguments; anchored to the installed script), `node scripts/evaluate-qa.mjs <profile.json> <evidence.json>` and `node scripts/evaluate-release.mjs <profile.json> <evidence.json>`. Follow the exact [evidence format](.agents/skills/pipeliner-maintain/references/evidence.md). Use a compatible local host and verify availability.
- Installation and updates use `scripts/adopt.mjs` from a reviewed upstream source checkout as described by `pipeliner-adopt`/`pipeliner-update`; the installer is not installed into adopters. Do not invoke it relative to an adopter checkout.

## Security, privacy, and documentation

- Use least privilege for tokens and workflows. Pin third-party GitHub Actions to immutable commit SHAs.
- Never expose secrets, credentials, private code, production data, session identifiers, or sensitive operational topology in Issues, pull requests, logs, screenshots, artifacts, or responses.
- Human-facing diagrams, policies, reports, and standalone documents must be self-contained HTML with Dark Mode. `README.md` is the required repository landing page; Markdown under `specs/` and `tasks/` is internal workflow metadata.
- Keep routine evidence in the Issue, pull request, checks, deployment output, and concise chat handoff. Do not create duplicate acceptance reports unless the PM requests one.
- Use `apply_patch` for hand-authored edits. Clean up only temporary processes, test artifacts, images, containers, and workspaces created for the current task; leave unrelated resources alone.
