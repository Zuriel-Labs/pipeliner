# Issue 5: Repository intake and local QA

## Outcome and scope

Adoption interviews support existing repositories and explicitly authorized creation. Developer availability, runtime platforms, ordered local QA turns, and release destinations are independent. Agents preserve customized policies, execute complete local suites, track cleanup, and publish evidence for each exact candidate without running application builds in Actions.

## Design

- PM correction: branch protection and rulesets are opt-in, never bootstrap defaults. Ask whether the PM wants protection and explain its review/check tradeoffs. Omitted choice preserves live settings and prompts; it never creates or removes controls. A recorded disabled choice leaves new repositories unprotected and permits removing existing controls only when explicitly requested. An enabled choice requires PM-resolved branch scope and rules before configuration. `quality.requiredChecks` remains agent verification metadata and does not itself authorize GitHub protection. Pipeliner's own profile records disabled, per the PM's explicit removal request.

- Keep version 1 profiles readable. An absent `qa` means discovery required, never an inferred successful single-host topology. Adoption and QA execution require an explicit validated `qa` section; migration takes PM-resolved QA input and preserves existing release settings.
- `qa` declares application type, runtime OS/architecture pairs, developer IDs and available environment IDs, environment setup/suite/teardown commands and prerequisites, and ordered turns with developer, environment, PM owner and approval phrase. Each environment must have a turn; each turn executes its whole environment suite. QA candidate identity defaults to no inferred fields: declare shared identity explicitly including sourceCommit and gitTree, independently of per-platform release identity.
- Pure intake decisions distinguish unspecified, existing, confirmed absent, and inaccessible/unknown. Creation requires explicit intent and complete owner/name/purpose/visibility/destination, plus verified absence and authority. These are decisions for the agent, not a credentialed creation daemon.
- Pure evidence evaluation checks exact candidate, ordered owner/environment/session, host compatibility, full successful suite, actual PM approval and cleanup. It yields current/next owner and environment, pickup/wait/remediation/complete; no handoff until exact candidate availability is recorded. Waiting remains active. Changed candidates invalidate all QA turns conservatively.
- Cleanup uses a task-created private workspace with an ownership marker; file deletion is confined to that workspace and rejects symlink roots/ancestors. External resources require exact recorded IDs, owner/run labels and explicit removal/readback evidence. No broad pruning or inferred process ownership. PM retention blocks completed turns until eventual removal is verified.
- Reconciliation retains manually merged target bytes using a manifest bound to both upstream and target SHA-256 plus review rationale. Never overwrites a conflict. Stale manifests reopen conflicts, and target drift after planning blocks apply. Semantic preservation is an agent review responsibility; hashes prove reviewed bytes, not policy equivalence.
- Replace reusable arbitrary command execution with fixed lightweight whitespace validation. Repository Actions use only reviewed lightweight commands. A workflow review ledger records exact workflow and transitive local file hashes, pinned external actions, and rationale. Validation fails on missing/stale coverage; agents inspect complete command chains, including package lifecycle hooks, local/composite actions, reusable workflows, containers and downloaded tools. Hash attestation does not prove arbitrary program behavior; unresolved chains are moved local or disabled. Never fabricate check runs from local evidence.

## Acceptance and verification

Behavior tests cover omitted/absent/inaccessible intake; four owner/OS topologies; missing host; partial/failed suite; wrong PM/candidate; self-handoff; cleanup success/failure/retention and unrelated-file survival; migration preservation; reconciliation repeatability and drift; CI review coverage and transitive drift. Temporary-target adoption validates generated artifacts. All changed skills pass quick_validate.py and npm run check passes. Manual scenario review records expected questions and observable outcomes in the PR.

## Non-goals and risks

No target application deployments, changes to reference repositories, automatic remote creation, generic shell safety prover, or automatic PM approval. Missing hosts and material choices stay pending. Legacy release profiles remain readable but cannot bypass QA discovery. Workflow reconciliation may require branch-protection check-name alignment; agents inspect and read back without weakening security checks. Release approval and PM completion remain separate gates.

## Ordered plan

1. Add failing tests for intake, QA/migration/evidence, cleanup, reconciliation and CI coverage.
2. Implement small dependency-free modules and callable CLI evidence validation.
3. Extend schema and four topology examples; retain legacy compatibility.
4. Integrate safe adoption reconciliation and CI validation.
5. Update README, root policy, canonical lifecycle skills and Project blueprint before handoff.
6. Run full local and scenario checks, inspect the diff, publish PR, verify exact CI head and prepare PM Testing.
