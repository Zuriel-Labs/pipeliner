# Implementation Plan: Pipeliner Bootstrap Repository

## Overview

Build the framework contract first, then implement deterministic adoption and audit tooling, add portable skills and provider adapters, add secure GitHub templates, and finally create and verify the public GitHub repository and working-example Project.

## Architecture Decisions

- Keep policy canonical in `AGENTS.md`, `.agents/pipeliner-policy.html`, and `.agents/skills`; adapters only redirect.
- Use a validated JSON adoption profile so stack, release topology, Project identity, commands, URLs, and approval phrases remain repository-owned.
- Model release strategies explicitly instead of flattening incompatible reference workflows.
- Make mutation tools plan-first, refuse collisions by default, and require an explicit flag for controlled replacement.
- Separate automated evidence from PM Testing and bind approvals to exact candidates.
- Use the live Project as a copyable example and keep a versioned blueprint for audit and reconstruction.

## Dependency Graph

```text
Specification
  -> configuration schema and blueprint
     -> adoption/validation libraries
        -> CLI tools and tests
           -> canonical skills and adapters
              -> repository workflows
                 -> live GitHub repository and Project
                    -> live readback and final verification
```

## Phases

### Phase 1: Contract and governance

- Define repository configuration, lifecycle, release strategies, PM Testing contract, and standalone Dark Mode policy.
- Establish canonical agent/provider file layout.

### Checkpoint: Contract

- Schema and examples parse.
- Policy terminology and safety boundaries are mechanically verifiable.

### Phase 2: Deterministic tooling

- Write failing tests for adoption planning, profile validation, identical-file handling, and collision refusal.
- Implement the smallest dependency-free modules and CLIs that make the tests pass.
- Add a repository-wide alignment validator and live Project auditor.

### Checkpoint: Tooling

- Focused tests and full Node suite pass.
- Dry-run makes no target changes; apply creates only planned files.

### Phase 3: Skills and provider compatibility

- Add focused lifecycle skills with progressive references for release strategies and Project operations.
- Generate regular-file Claude adapters and minimal root imports.
- Validate frontmatter, links, discovery metadata, and terminology.

### Checkpoint: Agent compatibility

- Bundled skill validator passes for every canonical skill.
- Alignment audit proves adapters and imports point to canonical files.

### Phase 4: GitHub templates and CI

- Add reusable quality workflow, repository quality workflow, Issue forms, CODEOWNERS example, and Project blueprint.
- Pin action dependencies by commit and enforce least privilege.

### Checkpoint: Repository gate

- `npm run check` exits zero.
- Workflow structure and pin audit pass.

### Phase 5: Publish and verify

- Create public `Zuriel-Labs/pipeliner`, push the exact verified tree, and enable required repository features.
- Copy the consolidated Project structure into a live `Pipeliner` Project, link the repository, inspect fields/views/workflows, and update the blueprint with its public working-example identity.
- Re-run local checks after final metadata updates and confirm local/remote commit identity.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Project-specific assumptions leak into the framework | High | Require all product, stack, host, and release details in the adoption profile; run a leakage audit. |
| GitHub Project APIs cannot configure every view or automation | Medium | Use Project copy for the working example, audit live state, document unsupported reconstruction boundaries. |
| Provider copies drift | High | Keep canonical files in `.agents/`, use regular-file adapters, and enforce exact adapter targets in CI. |
| Bootstrap overwrites adopter work | High | Dry-run by default in guidance, refuse collisions, and require explicit replacement with backups outside this initial scope. |
| Approval is reused after a candidate changes | High | Define candidate identity and require fresh PM approval after code/artifact/configuration changes. |
| Generic workflows become insecure or misleading | High | Least privilege, immutable action pins, explicit inputs, timeouts, and no default deployment mutation. |

## Verification Evidence

- Node tests and repository validator output.
- Skill quick-validation output.
- YAML parse/pin checks.
- Git status and exact local/remote SHA.
- `gh repo view`, `gh project view`, field list, repository link, view list, and workflow GraphQL readback.

## Issue 3: Autonomous target-driven adoption

### Contract

- Make install, bootstrap, adopt, align, and update requests explicit `pipeliner-adopt` entrypoints.
- Require a target location before target or Project mutation.
- Accept an absolute checkout path, GitHub `OWNER/REPO`, or GitHub URL and resolve exact repository identity.
- Preserve the target's policy and own the complete safe adoption workflow through PM Testing handoff.

### Implementation order

1. Extend the approved specification and task traceability.
2. Add a failing repository-validation test for the missing-target and autonomous-ownership contracts.
3. Extend the validator with focused contract checks.
4. Update the canonical root policy, adoption skill, OpenAI discovery metadata, Claude adapter description, and README quick start.
5. Run focused tests, canonical skill validation, the full repository gate, and realistic temporary-target adoption cases.
6. Commit, push, open a focused pull request, and hand the exact candidate to agent review.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| An agent mutates the wrong repository | Require an explicit target and verify local/remote identity before mutation. |
| Autonomous guidance weakens clarification gates | Ask for every unresolved material Project, release, credential, and rollback choice. |
| Adoption overwrites repository-owned policy | Preserve collision refusal and require deliberate reconciliation. |
| Source-only README rules break adopted repositories | Validate the portable contract in `AGENTS.md` and the canonical adoption skill; test README onboarding separately. |

### Verification checkpoints

- Focused tests demonstrate RED before implementation and GREEN afterward.
- `quick_validate.py` passes for `pipeliner-adopt`.
- `npm run check` exits zero.
- A temporary repository dry-run and apply remain conflict-safe and validate successfully.
