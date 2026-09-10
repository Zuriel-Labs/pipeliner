# Spec: Pipeliner Bootstrap Repository

## Objective

Create `Zuriel-Labs/pipeliner` as a public, MIT-licensed source of truth for adopting an agent-managed development and release pipeline in an arbitrary repository. Consolidate the durable methodology demonstrated by Versa, Strata, PointSite Builder, and Spectrune while keeping product, stack, host, and deployment details configurable.

The primary users are:

- a Project Manager (PM) who selects work, answers unresolved product questions, performs PM Testing, and grants exact-candidate approvals;
- ChatGPT/Codex agents that own normal repository, GitHub Project, validation, release, readback, and closeout work;
- other compatible agent providers that import or reference the canonical instructions and skills.

Success means a repository can adopt one consistent Issue-to-release lifecycle without copying product-specific assumptions.

## Requirements

1. Publish a public repository named `pipeliner` in the `Zuriel-Labs` organization under the MIT license.
2. Keep `AGENTS.md` and `.agents/skills/` canonical and ChatGPT-compatible by default.
3. Provide thin provider adapters instead of duplicating policy. At minimum, `CLAUDE.md` contains only `@AGENTS.md`, `GEMINI.md` imports `AGENTS.md`, and Claude skill adapters point to canonical skill files using regular files rather than symlinks.
4. Provide a project-agnostic lifecycle covering Issue creation, Backlog audit, work selection, implementation, agent review, candidate release, Production release, closure, pipeline health, adoption, and skill maintenance.
5. Enforce one active Issue by default, agent-owned Project movement, exact live readback after mutations, and fail-closed behavior when state is ambiguous.
6. Refer to human validation as `Project Manager QA` or `PM Testing`, never generic human QA.
7. Require agents to ask the PM focused clarifying questions when repository evidence cannot resolve a material ambiguity.
8. Require every review or release handoff to provide clear, numbered, change-specific PM Testing steps with prerequisites, target, actions, expected results, and regressions.
9. Support three release strategies through configuration:
   - immutable candidate promotion from a review environment to Production without rebuilding;
   - direct Production deployment followed by PM Testing and exact completion approval;
   - multi-environment or native-host validation where the same code candidate must be tested independently.
10. Provide a reusable GitHub Project schema and a live `Zuriel-Labs` Project named `Pipeliner` as a working example.
11. Provide bootstrap, validation, and Project-audit tooling that is dependency-free, safe by default, and test-covered.
12. Provide reusable GitHub Actions that use least privilege, concurrency control, timeouts, and immutable action pins.
13. Include a prominent README agent quick start that lets a user provide an absolute target checkout path, GitHub `OWNER/REPO`, or GitHub repository URL and delegate the complete adoption workflow.
14. Keep human-facing standalone policy documentation as self-contained Dark Mode HTML. Markdown specifications and task files are internal workflow metadata.
15. Never include reference-product secrets, private data, fixed local usernames, or sensitive infrastructure details.
16. Treat the target repository location as a mandatory adoption input. If it is absent, the agent asks one concise PM question for it and waits without mutating any target repository or GitHub Project.
17. Once a target is explicit, the agent owns identity resolution, evidence gathering, profile creation, conflict-safe adoption, Project and label alignment, validation, GitHub coordination, readback, and a user-friendly PM Testing handoff within that target scope.
18. Bootstrap `AGENTS.md` and canonical skills must make the GitHub Issue the primary reference in progress, blockers, review, release, approval requests, approval acknowledgments, and completion messages. Retain linked pull requests and exact candidate evidence as supporting details. Resolve approval placeholders from the Issue number, never the pull-request number; the default completion phrase is `Approved to complete Issue #{number}`. Preserve configured gate-specific phrases and bind them explicitly to the Issue and unchanged candidate. Never invent an Issue number when none exists.

## Issue communication maintenance plan

1. Define the shared communication contract in `AGENTS.md`, including distinct Issue and pull-request numbers in examples.
2. Apply it to the portable lifecycle skills, PM Testing reference, adoption reconciliation, and human-facing policy.
3. Verify a temporary adoption contains the updated instructions, skills, and existing approval defaults; run changed-skill validation and `npm run check`, then remove task-owned temporary output.

Acceptance: status leads with the Issue, approval acknowledgment identifies its Issue and candidate, and completion remains gated. Pull-request links, review, checks, merge evidence, release topology, and existing configured approval phrases remain intact. This is an instruction update, not a change to application logic or automatic updates of existing adopters. The main risk is accidentally treating Issue-level approval as permission for a changed candidate; the shared contract must explicitly forbid that.

## Non-goals

- Deploying an application or infrastructure workload from this repository.
- Prescribing a programming language, package manager, hosting vendor, registry, or GitOps controller.
- Automatically enabling destructive releases or bypassing repository-specific approvals.
- Treating merge, CI success, or deployment health as PM acceptance.
- Replacing product-specific tests, security controls, rollback procedures, or repository governance.

## Technical Stack

- Node.js 22 or later, ECMAScript modules, and built-in Node APIs only.
- JSON for the adoption profile and its machine-readable schema.
- GitHub CLI for repository and Project operations.
- GitHub Actions YAML for CI and reusable workflows.
- Markdown for agent instructions and repository README.
- Self-contained HTML/CSS with `color-scheme: dark` for the human-facing policy guide.

## Commands

- Install: `npm ci`
- Validate repository contracts: `npm run validate`
- Test: `npm test`
- Full local gate: `npm run check`
- Preview adoption safely: `node scripts/adopt.mjs --target /absolute/path/to/repository --config /absolute/path/to/pipeliner.config.json --dry-run`
- Apply adoption after review: `node scripts/adopt.mjs --target /absolute/path/to/repository --config /absolute/path/to/pipeliner.config.json`
- Audit a live Project: `node scripts/audit-project.mjs --config /absolute/path/to/pipeliner.config.json`

## Autonomous Adoption Contract

- Trigger `pipeliner-adopt` when the PM asks to install, bootstrap, adopt, or initially align Pipeliner in a repository. Existing-adoption updates use `pipeliner-update`; explicitly requested scheduled detection uses `pipeliner-monitor-updates`. Both operational skills run without a GitHub Issue under `specs/007-update-skills/spec.md`.
- Accept an absolute local checkout path, GitHub `OWNER/REPO`, or GitHub repository URL as the target location. An explicitly named current repository is also valid.
- If the request omits the target, ask exactly one focused question requesting the target repository location and wait. Reading Pipeliner guidance is allowed; target and Project mutations are not.
- Prefer an existing target checkout. When only a GitHub identity is supplied and no checkout exists, create an isolated checkout in a safe workspace and report its exact path.
- Verify local and remote repository identity before mutation. Preserve repository-owned instructions, dirty work, security controls, and stronger governance.
- Derive the profile from repository and live GitHub evidence. Ask only for material choices that evidence cannot resolve, including Project ownership, quality gates, release topology, approval phrases, credentials, and rollback authority.
- Preview all adoption operations, reconcile conflicts deliberately, and apply only a conflict-free plan. Never overwrite an existing file blindly.
- Use the target's existing Issue, branch, and pull-request process. If it has none, use a focused branch and pull request for the bootstrap unless the PM explicitly authorizes another supported path.
- Complete all in-scope repository and GitHub Project alignment, validation, readback, and clear PM Testing steps. Adoption does not authorize deployment, credentials changes, destructive migration, or unrelated work.

## Project Structure

- `AGENTS.md` — canonical operating contract for this repository.
- `.agents/pipeliner-policy.html` — Dark Mode human-facing pipeline model.
- `.agents/skills/` — canonical portable workflow skills.
- `.claude/skills/` — regular-file adapters to canonical skills.
- `blueprints/` — reusable Project, release-strategy, and adoption definitions.
- `schema/` — machine-readable configuration schema.
- `scripts/` — dependency-free adoption and validation tools.
- `test/` — Node test runner coverage for behavioral tooling.
- `.github/` — Issue forms and quality/reusable workflows.
- `specs/` and `tasks/` — internal specification and implementation state.

## Code Style

Use small ESM modules, explicit validation, safe defaults, and actionable errors. Prefer pure planning functions and inject side effects at the command boundary.

```js
export function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}
```

## Testing Strategy

- Unit tests cover configuration validation, placeholder rendering, destination planning, collision handling, and lifecycle invariants.
- Integration tests use temporary repositories to prove dry-run behavior, safe creation, refusal to overwrite, and provider-adapter generation.
- Repository validation checks instruction imports, skill frontmatter, adapter targets, Project schema, workflow pins, Dark Mode policy, and prohibited product-specific leakage.
- Live GitHub readback verifies repository visibility, default branch, Project linkage, fields, options, and workflow state after mutation.

## Boundaries

### Always

- Read repository instructions and live GitHub state before acting.
- Preserve unrelated and user-owned work.
- Use one coherent Issue as the primary work unit.
- Run configured validation and read back every external mutation.
- Identify exact candidate commit/tree/artifact/configuration state.
- Provide PM Testing steps in plain, user-friendly language.

### Ask first

- Materially ambiguous product behavior, acceptance criteria, release topology, PM approval phrase, destructive recovery, new credentials, or expanded external scope.
- Overwriting an existing adoption-managed file.
- Changing a currently approved candidate.

### Never

- Publish secrets or private operational values.
- Equate tests, merge, deployment, or silence with PM approval.
- rebuild an immutable candidate during promotion.
- ask the PM to perform routine Project bookkeeping that the agent can perform and verify.
- overwrite unknown files, rewrite shared history, or perform destructive rollback without explicit authorization.

## Success Criteria

- Local `npm run check` exits zero from a clean tree.
- All canonical skills pass the bundled skill validator and alignment audit.
- Adoption dry-run and temporary-repository integration tests pass.
- Every GitHub Action reference is pinned to a commit SHA and permissions are least-privilege.
- `CLAUDE.md` and `GEMINI.md` are minimal imports; every Claude skill adapter is a regular file with a valid canonical link.
- The public `Zuriel-Labs/pipeliner` repository exists, is reachable, uses `main`, and matches the pushed local commit.
- The live `Pipeliner` Project is linked to the repository and its required fields, options, views, and automations are read back.
- The README explains adoption, customization, verification, PM Testing, release strategies, and known GitHub Project API limitations.
- The README and root `AGENTS.md` provide a first-class autonomous adoption entrypoint, and the canonical adoption skill enforces the missing-target wait gate.
- Repository validation fails if the canonical target-location gate or autonomous adoption ownership contract is missing.

## Approved Decisions

- Repository visibility: Public.
- License: MIT.
- Live working-example Project: Create `Pipeliner` in `Zuriel-Labs`.
- Canonical provider: ChatGPT/Codex-compatible `AGENTS.md` plus `.agents/skills/`.
- Human validation terminology: Project Manager QA and PM Testing.

## Open Questions

Issue #5 extends this baseline with explicit creation intake, independent local QA and reviewed workflow reconciliation. See `specs/005-local-qa/spec.md`; its creation-intent alternative and local-only application builds supersede the existing-target-only intake and arbitrary reusable-command behavior described in this historical baseline.

None. Repository-specific choices are intentionally deferred to each adopter's configuration and PM clarification gate.
