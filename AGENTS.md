# Pipeliner agent operating contract

This repository uses Pipeliner: an evidence-first, agent-managed development and release lifecycle. Read this file, `pipeliner.config.json`, and the relevant canonical skill under `.agents/skills/` before acting.

## Pipeliner adoption entrypoint

- Treat requests to install, bootstrap, adopt, align, or update Pipeliner in a repository as `pipeliner-adopt` work before applying the normal lifecycle to that target.
- The target repository location is required. Accept an absolute local checkout path, GitHub `OWNER/REPO`, GitHub repository URL, or an explicit statement that the current repository is the target.
- If the target is omitted, ask one concise question: `What is the target repository location? Provide an absolute local checkout path, GitHub OWNER/REPO, or GitHub repository URL.` Then wait before target or Project mutation. Do not guess a repository from the current directory, recent work, or chat history.
- Once the target is explicit, read `.agents/skills/pipeliner-adopt/SKILL.md` and own its complete workflow. Verify exact local and remote identity before mutation and keep all authority bounded to that target repository and its linked Project.
- Adoption authority covers safe repository and Project alignment. It does not authorize application deployment, credential changes, destructive migration, or unrelated backlog work.

## Authority and source of truth

- The repository-owned profile in `pipeliner.config.json` defines repository identity, Project fields, quality commands, release strategy, environments, candidate identity, and exact approval phrases.
- `AGENTS.md` is the canonical provider-neutral instruction source. Provider files import or point to it; do not duplicate this policy.
- `.agents/skills/` is canonical for workflow skills. Provider-specific skill folders contain regular-file adapters, never copied policy or symlinks.
- `.agents/pipeliner-policy.html` is the human-facing lifecycle reference. Keep it self-contained and in Dark Mode.
- Live repository, Issue, pull request, Project, check, artifact, deployment, and runtime state outrank chat memory and cached identifiers.
- Preserve unknown or user-owned changes. Never reset, restore, clean, stash, overwrite, commit, publish, or deploy them without explicit direction.

## PM and agent responsibilities

- The Project Manager (PM) chooses product direction, resolves material ambiguity, performs Project Manager QA or PM Testing, reports findings, and grants exact-candidate approvals.
- Agents own normal research, specifications, implementation, tests, Project movement, GitHub coordination, releases, verification, readback, rollback within documented non-destructive authority, and concise closeout.
- When repository evidence cannot resolve a material choice, ask the PM focused clarifying questions, explain the tradeoff, and recommend a default when evidence supports one. Do not silently invent product behavior, release topology, acceptance criteria, credentials, or destructive recovery authority.
- Never ask the PM to perform routine Project bookkeeping the agent can perform and verify.

## Pipeline invariants

- One GitHub Issue is the primary unit of work. Pull requests and branches are supporting evidence.
- Exactly one Issue may be active by default. Active means the configured In Progress or In Review status. On Hold is inactive and only the PM may request it.
- Before Issue or code work, inspect the live Project, every active card, open Issues, open pull requests, relevant checks, current branch and head, and selected Issue. Fail closed on missing access, conflicting state, or more than one active Issue.
- The agent moves Project cards and immediately reads back Status, metadata, assignment, Issue state, and the active count.
- Keep Status, Priority, Impact, Effort, labels, assignee, Issue state, branch, and pull request linkage coherent at each transition.
- A merge is not a release. A release is not PM acceptance. Automation must never mark work complete before the configured release and PM Testing gates.

## Canonical lifecycle

1. New work uses `pipeliner-create-issue`. Research duplicates and repository behavior, clarify unresolved intent, show the complete Issue and metadata, obtain the configured exact approval, create it in Backlog, and read it back.
2. Backlog analysis uses `pipeliner-audit-backlog` and does not start implementation.
3. Implementation uses `pipeliner-work-issue`. Reserve the single active slot, create the configured focused branch, work spec-first and test-first, run repository gates, push, and create or update a pull request that references rather than auto-closes the Issue.
4. Agent review uses `pipeliner-review-issue`. Review and remediate correctness, security, data integrity, operations, accessibility, UX, compatibility, and tests in proportion to the change.
5. Candidate release uses `pipeliner-release-candidate` only when the configured strategy has a review or native environment.
6. Production release uses `pipeliner-release-production` only with the authorization and candidate identity required by the configured strategy.
7. Completion uses `pipeliner-close-issue` only after release verification and the configured PM acceptance gate.
8. Read-only diagnosis uses `pipeliner-pipeline-health`. Changes to these contracts use `pipeliner-maintain`.

## Specification and implementation

- Research current code, tests, documentation, official primary sources, and live service state before designing a material change.
- For medium or larger work, create or update a written specification, implementation plan, ordered tasks, acceptance criteria, non-goals, risks, and verification commands before implementation.
- Use Red, Green, Refactor for behavioral logic. Keep increments small, coherent, reversible, and verified.
- Prefer repository-native commands and existing architecture. Do not weaken tests, authentication, authorization, validation, audit logging, security controls, accessibility, CI, or release checks to make work pass.
- Run every configured quality command and inspect exit status before claiming success. List anything not run and why.

## Candidate and release contract

- Record every configured candidate-identity component. Typical components are source commit, Git tree, immutable artifact digest, rendered configuration, deployment revision, native platform, and validation session.
- Any change to a configured identity component invalidates prior PM approval. Re-run affected gates and request fresh approval.
- `immutable-promotion`: build the exact review candidate once, verify it in the review environment, obtain exact PM approval, and promote the same immutable artifact to Production without rebuilding.
- `direct-production`: merge the exact reviewed tree, deploy the exact clean default-branch revision, verify Production, then keep the Issue active until PM Testing and exact completion approval.
- `multi-environment`: each configured environment validates the exact code candidate independently. Approval from one environment cannot stand in for another.
- Record a known-good rollback target before deployment. A documented non-destructive application or GitOps rollback may be agent-owned; destructive schema or data recovery always requires explicit PM approval.

## PM Testing handoff

Every review, candidate, Production, and completion handoff must be user-friendly and include a `PM Testing steps` section with:

1. the exact target environment, URL, application, or artifact;
2. prerequisite account, state, fixtures, or setup;
3. numbered actions written in plain language;
4. expected result for each action;
5. focused regression and safety checks;
6. the exact candidate identity and current limitations;
7. the configured approval phrase in its own standalone fenced code block when approval is the next gate.

Agent tests and live verification support this handoff but never replace PM Testing. PM findings return the Issue to In Progress, invalidate the affected approval, and require remediation plus fresh verification.

## Repository-specific commands

- Install: `npm ci`
- Validate contracts: `npm run validate`
- Test behavior: `npm test`
- Full gate: `npm run check`
- Adoption preview: `node scripts/adopt.mjs --target <absolute-path> --config <absolute-config-path> --dry-run`
- Live Project audit: `node scripts/audit-project.mjs --config <absolute-config-path>`

## Security, privacy, and documentation

- Use least privilege for tokens and workflows. Pin third-party GitHub Actions to immutable commit SHAs.
- Never expose secrets, credentials, private code, production data, session identifiers, or sensitive operational topology in Issues, pull requests, logs, screenshots, artifacts, or responses.
- Human-facing diagrams, policies, reports, and standalone documents must be self-contained HTML with Dark Mode. `README.md` is the required repository landing page; Markdown under `specs/` and `tasks/` is internal workflow metadata.
- Keep routine evidence in the Issue, pull request, checks, deployment output, and concise chat handoff. Do not create duplicate acceptance reports unless the PM requests one.
- Use `apply_patch` for hand-authored edits. Clean up only temporary processes, test artifacts, images, containers, and workspaces created for the current task; leave unrelated resources alone.
