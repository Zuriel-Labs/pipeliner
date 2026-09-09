# Pipeliner

[![Quality](https://github.com/Zuriel-Labs/pipeliner/actions/workflows/quality.yml/badge.svg)](https://github.com/Zuriel-Labs/pipeliner/actions/workflows/quality.yml)

Pipeliner is a public, project-agnostic bootstrap for agent-managed development and release pipelines. It gives a repository one evidence-first path from a coherent GitHub Issue through implementation, review, release, Project Manager QA, and verified completion.

It is designed for ChatGPT and Codex by default, while keeping provider policy in one place and supplying thin compatibility files where another agent expects a different location.

The human-facing lifecycle and approval model is available in the self-contained Dark Mode [Pipeliner policy](.agents/pipeliner-policy.html).

## What Pipeliner standardizes

- One active Issue by default, with the Issue as the primary work unit.
- Agent-owned GitHub Project movement and immediate live readback.
- Specification and test-first implementation for material changes.
- Exact candidate identity across source, tree, artifact, configuration, deployment, platform, and validation session as applicable.
- Separate automated evidence, deployment health, and PM acceptance.
- Clear, numbered, change-specific `PM Testing steps` at every review and release handoff.
- Focused PM clarification when repository evidence cannot resolve an important choice.
- Safe adoption that refuses to overwrite an existing file.
- Canonical skills plus provider adapters that prevent copied policy from drifting.

## Methodology sources

Pipeliner consolidates four working pipeline families without copying their product-specific assumptions:

| Source | Durable lesson | Pipeliner result |
|---|---|---|
| Versa | Canary and Production must share one immutable candidate; merge is not release completion. | `immutable-promotion` strategy with exact digest and deployment identity. |
| Strata | A shared methodology must adapt to the real stack, persistence, topology, and available GitHub controls. | Repository profile plus explicit quality, data, environment, and rollback boundaries. |
| PointSite Builder | Some products deploy directly to one Production environment and require PM acceptance after deployment. | `direct-production` strategy with Production Showcase and completion approval. |
| Spectrune | Cross-platform software may require the same code candidate to pass independent native builds and PM Testing sessions. | `multi-environment` strategy with candidate-, platform-, and session-bound approvals. |

Across all four, Pipeliner retains the strongest common contracts: one active Issue, live-state reconstruction, agent-owned coordination, exact-candidate approval, remediation loops, complete QA, user-friendly PM Testing, and evidence before completion.

## Repository map

| Path | Purpose |
|---|---|
| `AGENTS.md` | Canonical repository operating contract. |
| `.agents/skills/` | Canonical ChatGPT/Codex and open Agent Skills packages. |
| `.claude/skills/` | Regular-file Claude adapters pointing to canonical skills. |
| `CLAUDE.md`, `GEMINI.md` | Minimal imports of the canonical root instructions. |
| `.agents/pipeliner-policy.html` | Dark Mode human-facing lifecycle reference. |
| `pipeliner.config.json` | This repository's validated adoption profile. |
| `schema/` | Machine-readable profile schema. |
| `blueprints/` | GitHub Project, labels, and complete release-strategy examples. |
| `scripts/` | Dependency-free adoption, repository validation, and live Project audit tools. |
| `.github/` | Secure CI, reusable quality workflow, Issue forms, and pull-request template. |
| `specs/`, `tasks/` | Internal specification, plan, and task traceability. |

## Prerequisites

- Git.
- Node.js 22 or later.
- GitHub CLI authenticated with access to the target repository and, when used, its organization Project.
- A clean understanding of the target repository's current instructions, checks, environments, release authority, and rollback path.

Confirm the GitHub session before Project work:

```sh
gh auth status
```

## Adopt Pipeliner

Use the `pipeliner-adopt` skill when an agent is performing the adoption. It requires evidence from the target repository and asks the PM only for choices the repository cannot answer.

### 1. Clone this source beside the target repository

```sh
git clone https://github.com/Zuriel-Labs/pipeliner.git
```

### 2. Choose the closest complete profile

- `blueprints/profiles/immutable-promotion.config.json` for a review environment whose exact immutable artifact is promoted to Production.
- `blueprints/profiles/direct-production.config.json` for one Production deployment followed by PM Testing and completion approval.
- `blueprints/profiles/multi-environment.config.json` for independent native hosts or validation environments.

Copy one profile to a temporary working file:

```sh
cp pipeliner/blueprints/profiles/immutable-promotion.config.json /tmp/pipeliner.config.json
```

Edit every example value. At minimum, confirm:

- repository owner, name, default branch, and PM username;
- live Project owner, number, title, fields, and exact option spelling;
- focused branch pattern and non-closing Issue reference;
- exact approval phrases;
- every repository quality command and required check name;
- real release strategy, environments, URLs, build/deploy/verify commands, and candidate identity;
- rollback authority, data preservation, authentication, security, and accessibility requirements in the target `AGENTS.md`.

Do not preserve an example command merely because it exists. An unresolved material value is a PM clarification question, not a placeholder to guess.

### 3. Preview every file operation

Use absolute paths:

```sh
node pipeliner/scripts/adopt.mjs --target /absolute/path/to/target --config /tmp/pipeliner.config.json --dry-run
```

The plan reports:

- `create`: files that do not exist and can be added safely;
- `identical`: files already aligned byte-for-byte;
- `conflicts`: existing files with different content.

Pipeliner never overwrites a conflict. Read both versions and merge the contracts deliberately. Existing repository-specific instructions remain authoritative when they are stronger or more precise.

### 4. Apply only a conflict-free plan

```sh
node pipeliner/scripts/adopt.mjs --target /absolute/path/to/target --config /tmp/pipeliner.config.json
```

The adoption includes canonical policy and skills, Claude adapters, Issue forms, the reusable quality workflow, schemas, blueprints, and the audit tools. It does not replace the target's stack-specific CI, deployment code, credentials, or runtime configuration.

### 5. Validate the target

Run from the target repository:

```sh
node scripts/validate-repository.mjs
```

Then run every quality command declared in the target's `pipeliner.config.json`. Fix all failures before treating adoption as aligned.

## Create the GitHub Project

The public working example is [Zuriel-Labs Project Pipeliner](https://github.com/orgs/Zuriel-Labs/projects/3). Copying it preserves the built-in field, view, and workflow structure that the public GitHub CLI cannot fully author from scratch.

Create a structure-only copy in the target organization:

```sh
gh project copy 3 --source-owner Zuriel-Labs --target-owner TARGET_ORG --title "TARGET_PROJECT"
```

Link the returned Project number to the target repository:

```sh
gh project link TARGET_PROJECT_NUMBER --owner TARGET_ORG --repo TARGET_REPOSITORY
```

Set the intended Project visibility:

```sh
gh project edit TARGET_PROJECT_NUMBER --owner TARGET_ORG --visibility PRIVATE
```

Configure an `Auto-add to project` filter when the organization and repository need automatic intake. Then run the bundled read-only audit:

```sh
node scripts/audit-project.mjs --config /absolute/path/to/target/pipeliner.config.json
```

The required working-example structure is versioned in `blueprints/github-project.json`:

- Status: `Backlog`, `On Hold`, `In Progress`, `In Review`, `Done`.
- Priority: `P0`, `P1`, `P2`, `P3`.
- Impact: `High`, `Medium`, `Low`.
- Effort: `XS`, `S`, `M`, `L`, `XL`.
- Backlog and Kanban board views.
- Item-added, item-closed, linked-pull-request, sub-Issue, and close automations.
- `Pull request merged` disabled because merge is not release completion or PM acceptance.

Apply the label taxonomy in `blueprints/github-labels.json` with `gh label create` or `gh label edit`, then read the labels back. Add product-specific area labels only when they describe real repository ownership.

## Release strategies

### Immutable promotion

Use when a review environment and Production run the same deployable artifact. Build the exact pull-request candidate once, resolve its immutable identity from the artifact authority, deploy and verify it in review, receive exact PM approval, and promote the same artifact without rebuilding.

### Direct Production

Use when the product has no application Canary or staging environment. Complete agent QA against the exact pull-request tree, merge and deploy the exact default-branch revision through the repository's authorized path, verify Production, then keep the Issue In Review for PM Testing. Only exact approval of that unchanged Production candidate permits Done.

### Multi-environment

Use when platform or host behavior cannot be proven from one environment. Each configured environment builds, launches, verifies, and receives PM Testing against the exact candidate. Findings create a new candidate and repeat every affected validation. One host's approval never substitutes for another.

### No application release

Use `none` for documentation or tooling repositories that have no application deployment. Source commit, Git tree, checks, review, and configured PM acceptance still define completion.

## PM Testing standard

Every review and release handoff must tell the PM exactly what to test. It includes the target, prerequisites, numbered actions, an expected result for each action, focused regressions, candidate identity, known limitations, and the exact approval phrase when approval is next.

Automated tests and agent QA do not replace Project Manager QA. A PM finding returns the Issue to In Progress, invalidates affected approval, and starts a fresh remediation and verification loop.

## Reuse the quality workflow

The reusable workflow is stack-neutral. A caller owns its setup and quality commands:

```yaml
jobs:
  quality:
    uses: Zuriel-Labs/pipeliner/.github/workflows/reusable-quality.yml@PINNED_PIPELINER_COMMIT
    with:
      setup-command: npm ci
      quality-command: npm run check
```

Pin `PINNED_PIPELINER_COMMIT` to a reviewed full commit SHA. Do not call a mutable branch from a protected pipeline. The reusable workflow grants only `contents: read`; deployment and environment secrets stay in repository-specific release workflows.

## Provider compatibility

- ChatGPT/Codex and compatible Agent Skills hosts use `.agents/skills/` as the canonical packages.
- [Claude Code](https://code.claude.com/docs/en/skills) discovers `.claude/skills/<name>/SKILL.md`; Pipeliner adapters link back to the canonical package and remain ordinary files for cross-platform Git behavior.
- [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/using-agent-skills.md) recognizes `.agents/skills/` as a workspace alias, so no copied `.gemini/skills` tree is needed. `GEMINI.md` imports the root policy.
- Other providers should receive the smallest supported import or adapter that points to the canonical files. Never copy the full policy into a provider-specific location.

## Update an adoption

1. Fetch a reviewed Pipeliner revision.
2. Run adoption with `--dry-run` against the target's current profile.
3. Inspect every difference and preserve target-specific governance.
4. Apply a conflict-free plan or merge conflicts manually.
5. Run the target validator, skill validation, repository quality gates, and live Project audit.
6. Commit the aligned target changes through its normal Issue pipeline.

Pipeliner does not silently synchronize adopters. Each repository controls when a framework revision is reviewed and adopted.

## GitHub automation limits

GitHub exposes Project copy, linking, fields, visibility, and readback through `gh`, but not every built-in view and workflow authoring control. Pipeliner therefore uses a live copyable Project as the working example and treats `blueprints/github-project.json` plus `scripts/audit-project.mjs` as the declared and verified contract.

Always discover live IDs and option names. Never copy GraphQL node IDs from the working example into another organization.

## Contributing

Open one coherent Issue before material work. Keep the single active slot intact, use the canonical skill for the lifecycle stage, add tests for behavior, run `npm run check`, and keep pull requests linked with `Refs #N` rather than an auto-close keyword.

This repository is licensed under the [MIT License](LICENSE).
