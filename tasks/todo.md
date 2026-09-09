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

- [ ] Write tests for canonical structure and Project blueprint invariants.
- [ ] Implement repository alignment validation and a read-only live Project auditor.
- [ ] Verify success and intentional failure cases.
- Dependencies: Tasks 1-2.
- Files: `test/validate.test.mjs`, `scripts/validate-repository.mjs`, `scripts/audit-project.mjs`, `blueprints/github-project.json`.

## Task 4: Add portable workflow skills

- [ ] Add adoption, Issue, audit, work, review, release, closure, health, and maintenance skills.
- [ ] Keep conditional release details in focused references.
- [ ] Add OpenAI discovery metadata and Claude regular-file adapters.
- [ ] Verify every skill with the bundled quick validator and the repository alignment audit.
- Dependencies: Tasks 1-3.
- Files: `.agents/skills/**`, `.claude/skills/**`, `CLAUDE.md`, `GEMINI.md`.

## Task 5: Add secure GitHub repository templates

- [ ] Add local and reusable quality workflows with immutable action pins and least privilege.
- [ ] Add Issue forms and pull-request template aligned to the lifecycle.
- [ ] Add package scripts and lockfile for repeatable local/CI checks.
- Dependencies: Tasks 1-4.
- Files: `.github/**`, `package.json`, `package-lock.json`.

## Task 6: Write adoption instructions

- [ ] Explain prerequisites, profile decisions, dry-run, application, Project copy/linking, validation, PM Testing, and upgrade alignment.
- [ ] Distinguish the three release strategies and known automation limitations.
- [ ] Verify all commands and links against the implemented tree.
- Dependencies: Tasks 1-5.
- Files: `README.md`, `CONTRIBUTING.md`.

## Task 7: Publish the working example

- [ ] Create public `Zuriel-Labs/pipeliner`, push `main`, and verify repository state.
- [ ] Create and link the live `Pipeliner` Project by copying the approved structure.
- [ ] Read back fields, options, views, workflow states, and repository linkage.
- [ ] Update the blueprint/README with live working-example identity, rerun checks, push, and verify exact SHA.
- Dependencies: Tasks 1-6.
- Files: `blueprints/github-project.json`, `README.md` plus GitHub repository/Project state.
