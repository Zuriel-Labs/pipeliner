# Issue #12: Message questions end the turn

## Outcome and acceptance

An unanswered clarification or approval ends the agent turn with an ordinary
message marked `Question:`. No native question UI, tool call, background work,
polling, sleep, timer, reminder, or silence-based default follows the question.
Only a Human reply resumes the task. Save known answers before asking, reuse them
on resume, and ask only remaining unresolved questions. This supersedes the
earlier permission to continue independent work while awaiting an answer.

## Design

- Put the full contract in the shared questions reference and AGENTS.md; surface
  the turn boundary in canonical skill entrypoints and bootstrap/update prompts.
  Keep provider imports and thin adapters pointing to canonical policy.
- Add `endTurn` to the pure clarification decision. It reports a decision over
  supplied evidence, not a runtime hook or proof that a provider obeyed it.
- Extend known-directive validation for the reported GPT-feature instruction,
  named native question tools and superseded independent-work wording. Check
  root provider instructions, canonical skills, adapter text and YAML prompts.
- Before any installer writes, expose question conflicts in source or existing
  managed instructions even when identical or accepted by a hash reconciliation.
  A conflicting plan is rejected. The agent must reconcile authorized text and
  regenerate review hashes; the installer never rewrites existing target bytes.
- Scan known text patterns only: this cannot prove arbitrary prose safe or inspect
  host-injected instructions. Agents must review effective instructions manually,
  explain higher-priority host conflicts, and never claim repository policy can
  override those instructions. Do not edit global settings or unrelated files.

## Ordered implementation and verification

1. Add failing decision, directive and adoption regression tests.
2. Implement detection and fail-closed plan/application checks; preserve file,
   symlink, drift and reconciliation protections.
3. Align canonical guidance, discovery, prompts, policy and current documentation.
4. Run focused tests, every changed skill through quick_validate.py, and
   `npm run check`. Exercise fresh, repeat, customized and conflicting adoption
   using task-owned fixtures with teardown. Verify installed source bytes.
5. Review the complete diff, publish a non-closing PR, and present candidate-bound
   PM Testing. Keep Issue #12 In Progress until the configured PM accepts it.

## Risks and exclusions

False-positive text matches are possible; test prohibitions, ordinary prose and
workflow-specific independent work. Detection is intentionally bounded, not a
natural-language parser. Static tests do not establish live provider execution;
report unavailable runtime checks explicitly. No automatic adopter upgrades,
provider configuration changes, new scheduler, new skill entrypoints, deployments
or weakened approval gates. Preserve all unrelated resources and instructions.

## Research

Inspected current canonical references, lifecycle helper, repository validator,
installer and reconciliation tests. Claude skill documentation
(https://code.claude.com/docs/en/skills) and OpenCode skills documentation
(https://opencode.ai/docs/skills/) checked 2026-09-10: retain their existing
discovery paths and canonical links. No new provider mechanism is necessary.
