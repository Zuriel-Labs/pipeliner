---
name: pipeliner-adopt
description: Adopt or align Pipeliner governance, skills, provider adapters, and Project structure in a repository without overwriting repository-owned policy.
---

# Adopt Pipeliner

Read the target repository's complete instructions, current Git state, build/test commands, release topology, and GitHub Project before proposing changes.

1. Inventory existing `AGENTS.md`, provider files, skills, workflows, Issue templates, release procedures, and dirty work. Preserve every unknown change.
2. Resolve the adoption profile from evidence. Ask the PM focused questions for any unresolved Project owner, PM identity, quality gate, environment, candidate identity, approval phrase, or rollback boundary.
3. Create a valid `pipeliner.config.json`. Choose the release strategy that matches the real system; do not manufacture Canary, Production, or native environments.
4. Run `node scripts/adopt.mjs --target <absolute-target> --config <absolute-config> --dry-run` from Pipeliner. Review every create, identical, and conflict result.
5. Reconcile conflicts deliberately. Merge the Pipeliner contract into stronger repository-specific instructions rather than replacing them. Never bypass collision refusal or overwrite an existing policy blindly.
6. Run the adoption command without `--dry-run` only after the plan has no conflicts. Add project-native commands, boundaries, and release detail that the generic contract cannot infer.
7. Copy or reconstruct the GitHub Project from `blueprints/github-project.json`, link the target repository, configure auto-add filters as appropriate, and read back fields, views, workflows, linkage, and visibility. Keep merge-driven completion disabled.
8. Run the target's full quality gate plus Pipeliner repository validation. Confirm provider imports and skill adapters resolve from regular files.
9. Present concise adoption evidence, remaining limitations, and numbered PM Testing steps for the repository's actual workflow.

Adoption authorizes only the target repository and Project placed in scope. It does not authorize application deployment, destructive migration, credential changes, or unrelated backlog mutation.
