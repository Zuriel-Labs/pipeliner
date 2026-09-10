# Pipeliner Bootstrap Tasks

## Task 1: Define the framework contract

- [x] Add configuration schema and an adoption profile example.
- [x] Add the canonical repository `AGENTS.md` and Dark Mode policy.
- [x] Verify required lifecycle, PM Testing, ambiguity, and release-strategy language.
- Dependencies: None.
- Files: `schema/pipeliner.schema.json`, `pipeliner.config.json`, `AGENTS.md`, `.agents/pipeliner-policy.html`.

## Task 2: Build adoption behavior test-first

- [x] Write tests that fail without profile validation, file planning, identical-file handling, and safe collision behavior.
- [x] Implement dependency-free libraries and `scripts/adopt.mjs`.
- [x] Verify dry-run and temporary-target apply behavior.
- Dependencies: Task 1.
- Files: `test/adopt.test.mjs`, `scripts/lib/config.mjs`, `scripts/lib/adoption.mjs`, `scripts/adopt.mjs`.

## Task 3: Build framework and Project audits

- [x] Write tests for canonical structure and Project blueprint invariants.
- [x] Implement repository alignment validation and a read-only live Project auditor.
- [x] Verify success and intentional failure cases.
- Dependencies: Tasks 1-2.
- Files: `test/validate.test.mjs`, `scripts/validate-repository.mjs`, `scripts/audit-project.mjs`, `blueprints/github-project.json`.

## Task 4: Add portable workflow skills

- [x] Add adoption, Issue, audit, work, review, release, closure, health, and maintenance skills.
- [x] Keep conditional release details in focused references.
- [x] Add OpenAI discovery metadata and Claude regular-file adapters.
- [x] Verify every skill with the bundled quick validator and the repository alignment audit.
- Dependencies: Tasks 1-3.
- Files: `.agents/skills/**`, `.claude/skills/**`, `CLAUDE.md`, `GEMINI.md`.

## Task 5: Add secure GitHub repository templates

- [x] Add local and reusable quality workflows with immutable action pins and least privilege.
- [x] Add Issue forms and pull-request template aligned to the lifecycle.
- [x] Add package scripts and lockfile for repeatable local/CI checks.
- Dependencies: Tasks 1-4.
- Files: `.github/**`, `package.json`, `package-lock.json`.

## Task 6: Write adoption instructions

- [x] Explain prerequisites, profile decisions, dry-run, application, Project copy/linking, validation, PM Testing, and upgrade alignment.
- [x] Distinguish the three release strategies and known automation limitations.
- [x] Verify all commands and links against the implemented tree.
- Dependencies: Tasks 1-5.
- Files: `README.md`, `blueprints/profiles/*.json`.

## Task 7: Publish the working example

- [x] Create public `Zuriel-Labs/pipeliner`, push `main`, and verify repository state.
- [x] Create and link the live `Pipeliner` Project by copying the approved structure.
- [x] Read back fields, options, views, workflow states, and repository linkage.
- [x] Update the blueprint/README with live working-example identity, rerun checks, push, and verify exact SHA.
- [x] Historical bootstrap enabled main protection; superseded by the PM's Issue #5 correction: remove protection here and make it an explicit opt-in interview choice for adopters.
- Dependencies: Tasks 1-6.
- Files: `blueprints/github-project.json`, `README.md` plus GitHub repository/Project state.

## Task 8: Make adoption autonomous from an explicit target

- [x] Approve and record the target-location, ownership, safety, and PM Testing contract.
- [x] Add a failing validator test for missing autonomous-adoption instructions.
- [x] Implement deterministic contract validation.
- [x] Add the root-policy adoption entrypoint and strengthen the canonical adoption skill and provider metadata.
- [x] Add the README agent quick start and supported target formats.
- [x] Run focused tests, skill validation, the full gate, and temporary-target adoption verification.
- [x] Publish the Issue #3 pull request and hand it to agent review.
- Dependencies: Tasks 1-7.
- Files: `specs/001-bootstrap/spec.md`, `tasks/plan.md`, `tasks/todo.md`, `AGENTS.md`, `README.md`, `.agents/skills/pipeliner-adopt/**`, `.claude/skills/pipeliner-adopt/SKILL.md`, `scripts/lib/validation.mjs`, `test/validate.test.mjs`.
