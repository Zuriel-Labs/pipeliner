# Reconciliation and Actions review

The agent owns semantic review. Hashes bind the reviewed files; they cannot prove policy strength or absence of application builds in arbitrary scripts.

## Customized files

1. Read upstream and target instructions completely. Preserve dirty work and stronger constraints. Manually merge only adoption-authorized changes; never overwrite unknown changes.
   Verify the merged `AGENTS.md` and canonical skills retain Issue-based status, handoffs, approval requests and acknowledgments, Issue-number completion placeholders, and exact-candidate binding. Preserve pull-request linkage, review/check requirements, and merge evidence as supporting details; a matching digest alone cannot establish these semantics.
2. Save a target-owned `.agents/reconciliation.json` with version 1 and a `files` object keyed by managed relative path. Each entry has `sourceSha256`, `targetSha256`, and a non-empty `rationale` explaining retained policy and integration. Compute SHA-256 over exact bytes after review using Node crypto or the host's SHA-256 tool. Do not store credentials or private source in rationale.
3. Pass its absolute path using `--reconciliation` to both dry-run and apply. Reconciled files remain untouched. Changes to upstream or target invalidate the entry and reopen the conflict; update only after a fresh semantic review. Apply rechecks existing bytes before creation.
4. Run target repository validation, skill validation and full local gates. Reconcile stronger provider policies by preserving content and a canonical import; explain any structural validator mismatch rather than deleting policy.

## Actions review

Branch protection is an independent, optional PM choice, not an installation requirement. Never create branch protection or rulesets from check names alone. Ask whether protection is wanted, then clarify exact branch scope and rules if enabled. Preserve existing controls until explicitly instructed to change or remove them. An unprotected repository still requires agent verification and PM acceptance under Pipeliner.

Inspect all `.github/workflows` files before pushing, including disabled or manually triggered workflows. Expand every command: package pre/post hooks, executable scripts and imports, local actions, nested workflows, Dockerfiles, action pins and downloaded executables. Build/test application packages and images locally. If a command's behavior cannot be established, move it local or block until resolved. Security scanners may inspect source and use prebuilt tooling; they must not build the application.

The reusable workflow now accepts no command inputs and runs only Git whitespace checks. Remove `setup-command`, `quality-command`, and `runner` from callers when upgrading; keep full suites in `qa.environments[].suite` and `quality.commands`. An older pinned workflow remains old behavior until deliberately upgraded. Preserve required security checks; update obsolete check names only after equivalent lightweight checks and local evidence gates are in place and read protections back.

Write `.agents/ci-review.json`: version 1, `workflows` keyed by every workflow's repository-relative path. Each entry contains `rationale` describing the inspected command chain and immutable external action behavior, plus `files` mapping that workflow and ALL transitive local executable/configuration inputs to SHA-256. Include package manifests/locks and local action Dockerfiles when reachable. Exclude the ledger itself. No automatic mass acknowledgment of hashes. New commands, dependencies or workflow changes require review and refreshed coverage before publication. `auditCI` rejects missing/stale hashes and escaping paths; it cannot discover every dynamic dependency or detect an intentionally false rationale. Agent review remains mandatory.

On fresh adoption, review the generated reusable workflow and existing workflows together; generate a target-specific ledger. Never copy Pipeliner's own repository command review into a different stack.

Primary references: [GitHub repository creation](https://cli.github.com/manual/gh_repo_create), [reusable workflow inputs and calls](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows), [Claude canonical imports](https://code.claude.com/docs/en/memory).
