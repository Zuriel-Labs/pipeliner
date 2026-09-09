---
name: pipeliner-adopt
description: Install, bootstrap, adopt, update, or align Pipeliner in an explicit target repository through verified PM Testing handoff.
---

# Adopt Pipeliner

## Target repository location gate

The target repository location is required. Accept an absolute local checkout path, GitHub `OWNER/REPO`, GitHub repository URL, or an explicit statement that the current repository is the target.

If the request does not identify a target, ask one concise question: `What is the target repository location? Provide an absolute local checkout path, GitHub OWNER/REPO, or GitHub repository URL.` Then wait before target or Project mutation. Do not infer a target from the current directory, recent repositories, memory, or an unrelated open task.

When a local path is supplied, resolve its Git root and verify its remote identity. When a GitHub identity or URL is supplied, use `gh repo view` to verify it, prefer an existing known checkout, and otherwise create an isolated safe checkout. Report the exact checkout used. Stop and clarify if local and remote identities disagree.

## Autonomous adoption workflow

Read the target repository's complete instructions, current Git state, build/test commands, release topology, and GitHub Project before proposing changes. Own the complete autonomous adoption workflow: resolve identity, create the profile, dry-run, reconcile conflicts, align the GitHub Project, validate, read back, and provide PM Testing steps.

1. Confirm scope and identity. Record the exact target checkout, GitHub `OWNER/REPO`, default branch, repository visibility, clean or dirty state, and applicable instruction files. Preserve every unknown change.
2. Inventory existing `AGENTS.md`, provider files, skills, workflows, Issue templates, quality commands, release procedures, environments, labels, branch protections, and Project configuration.
3. Follow the target's existing Issue, branch, and pull-request governance. If none exists, use a focused branch and pull request for the bootstrap unless the PM explicitly authorizes another supported path.
4. Resolve the adoption profile from repository and live GitHub evidence. Ask the PM focused questions only for unresolved material choices such as Project owner, PM identity, quality gates, release topology, candidate identity, approval phrases, credentials, visibility, or rollback authority.
5. Create a valid `pipeliner.config.json`. Choose the release strategy that matches the real system; do not manufacture Canary, Production, or native environments.
6. Run `node scripts/adopt.mjs --target <absolute-target> --config <absolute-config> --dry-run` from a reviewed Pipeliner revision. Review every create, identical, and conflict result.
7. Reconcile conflicts deliberately. Merge the Pipeliner contract into stronger repository-specific instructions rather than replacing them. Never bypass collision refusal or overwrite an existing policy blindly. Repeat the dry-run until it is conflict-free.
8. Run the adoption command without `--dry-run`. Add project-native commands, boundaries, and release detail that the generic contract cannot infer.
9. Copy or reconstruct the GitHub Project from `blueprints/github-project.json`, link the target repository, align the label taxonomy, configure supported automations and auto-add filters, and read back fields, views, workflows, linkage, visibility, and labels. Keep merge-driven completion disabled.
10. Validate provider imports and skill adapters as regular files. Run the target's Pipeliner repository validation and every configured quality command. Resolve failures without weakening target policy or safety gates.
11. Commit only intended target files, push the focused branch, and create or update the governed pull request. Read back the exact branch, commit, tree, pull request, checks, Issue, and Project state.
12. Present concise adoption evidence, remaining limitations, and user-friendly numbered PM Testing steps for the target's actual workflow, with a clear expected result for every action.

Adoption authorizes only the target repository and Project placed in scope. It does not authorize application deployment, destructive migration, credential changes, or unrelated backlog mutation.
