# Issue #7: Agent-led lifecycle and portable bootstrap

This specification supersedes conflicting routing/identity wording in the baseline specification. Scope is the exact approved Issue #7. No changes are installed into adopter repositories during framework development.

## Requirements and decisions

- Agents continue within the requested Issue through work, review, release and close skills. Only material answers, configured PM Testing/approval, unavailable access/hosts or actual external controls pause dependent work. Completion does not authorize another Issue. Read-only audit requests never select implementation work.
- Selection honors the sole active Issue, then an explicitly requested ready Issue. Otherwise choose a dependency-ready open Backlog Issue by profile priority option order (highest first), then lowest Issue number. Incomplete selection evidence is a question, not guessed priority/readiness. An explicit different Issue cannot displace active work. On Hold needs explicit resumption.
- Superseded by Issue #12: use only final ordinary messages marked `Question:` and end the turn immediately. Stop all task work and tool calls until the Human replies. No native question controls, polling, sleep loops, background continuation, timers, reminders or silence-based answers. Preserve resolved answers before asking and reuse them on resume. Report higher-priority host conflicts explicitly.
- Review may resume In Progress or In Review. After merge, feedback returns the same Issue to In Progress and remediation starts from the current default branch in a new supporting PR. A healthy deployed candidate routes to its pending PM acceptance gate, not back to an open-PR precondition.
- `release.preReleaseIdentity` optionally declares identity available at the pre-merge/release approval gate; it includes sourceCommit/gitTree and is a subset of final `candidateIdentity`. Legacy none/direct-production defaults to sourceCommit/gitTree; immutable/native defaults conservatively to full candidateIdentity, with discovery if final-only components make that impossible. New profiles explicitly classify identity. No invented deployment ID. Exact final identity remains mandatory before completion.
- Direct Production: local agent/QA gates, configured Production authorization against pre-release identity, exact-tree merge, deployment, final identity and live verification, Production PM acceptance, closure. Local QA PM gates remain independent; no invented staging. `none`: QA then completion approval against source candidate, exact-tree merge, readback and close without invoking Production. Immutable/native candidates are built and verified before their approvals; promotion uses the same artifact. Expected merge commit or environment-specific deployment IDs are recorded as explicit stage transitions with unchanged reviewed tree/artifact, not silently treated as arbitrary candidate changes.
- Project audit takes identity and mapped fields from the target profile and uses optional `project.visibility` (PUBLIC/PRIVATE); omitted visibility is reported as observed and is never changed. Fetch a verified Project node ID through `gh project view` for either owner type, then paginate each GraphQL connection separately. Fail closed on partial/error/null/repeated cursor/duplicate identities or changed Project identity during the audit. Blueprint workingExample remains attribution, not target expectation.
- Shared AGENTS.md becomes stack-neutral: quality commands come from profile, installed Pipeliner validators use Node 22+, installer runs only from a reviewed upstream source checkout. No copying package.json or installer is required. Adoption checks installed relative references, preserves custom bytes and tests a non-Node fixture without package.json.
- Canonical references describe decisions, while small pure helpers make selection/question/review/identity rules testable. Helpers neither mutate nor authenticate supplied evidence. Agents must verify real state and approvals.

## QA and acceptance

PM confirmed one local macOS arm64 turn with brimdor as PM. Pipeliner is tooling; suite is `npm run check` including all Node/adoption scenarios. No app server or container is needed. Reuse the profile's existing `Beta approved` wording for local QA; final completion remains `Approved to complete Issue #{number}`. Configure and verify the roster before candidate QA. Keep In Progress while awaiting PM Testing. Node tests remove owned temporary directories in teardown; no external test resources are needed.

Acceptance matches Issue #7: deterministic authorized start; native/message indefinite questions; resumed and post-merge remediation; reachable gates for all strategies; private/user/custom-field Project audits; portable repeatable non-Node adoption; full local gates, provider link checks and cleanup. Instruction scenario checks do not claim live behavior in unavailable providers.

## Plan

1. Add failing tests for adopter Project expectations, paginated user/org fetching and malformed responses, non-Node command/link portability, and lifecycle routing/identity.
2. Implement small pure decision helpers and portable Project audit. Extend optional schema fields with compatible defaults and strict validation.
3. Align canonical contract, lifecycle skills/references, provider metadata, policy, examples and adoption/update instructions. Add Pipeliner's confirmed local QA roster.
4. Run focused tests; review all diffs and release routes, remediate; validate skills and all installed relative links; run full gate and live read-only Project audit. Refresh only semantically reviewed CI digests.
5. Commit/push the focused branch, create a non-closing PR for Issue #7, verify exact checks and candidate; lead into PM Testing with actionable target and steps. Publish test evidence to Issue/PR, keep active until approval, and clean all owned temporary resources.

## Non-goals and risks

No adopter updates, application deployment, scheduling, unrelated dependency changes, weakened gates, or global cleanup. Highest risks are approval scope widening, overlooking customized policies, and reporting incomplete GraphQL data as healthy. Cover these with rejection tests and live readback. No new dependency or hosted execution engine.

## Primary sources

- GitHub GraphQL pagination: https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api
- GitHub schema introspection: ProjectV2 connection arguments and ProjectV2FieldConfiguration types verified live with `gh api graphql`.
- GitHub reusable workflows: https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows
- Native prompting follows the active provider's actual tool schema rather than hard-coded provider API names.
