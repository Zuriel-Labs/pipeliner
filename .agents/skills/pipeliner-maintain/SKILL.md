---
name: pipeliner-maintain
description: Create, update, and validate Pipeliner policy, canonical skills, provider adapters, schemas, blueprints, and deterministic alignment checks.
---

# Maintain Pipeliner

Use this skill for changes to `AGENTS.md`, provider imports, `.agents/`, `.claude/skills/`, `pipeliner.config.json`, schemas, blueprints, adoption tooling, or alignment validation.

Use [pipeliner-update](../pipeliner-update/SKILL.md) to incorporate an upstream revision into an existing adopter; use this skill to author framework changes. Explicitly requested scheduled detection uses [pipeliner-monitor-updates](../pipeliner-monitor-updates/SKILL.md); maintaining the framework never schedules a monitor by itself.

- Read the current specification, policy, skills, adapters, tests, and reference-provider documentation before editing.
- Keep shared authority canonical. Root provider files import `AGENTS.md`; `.agents/skills/` contains full skills; `.claude/skills/` contains regular-file adapters with relative canonical links.
- Keep skill names concise, descriptions discriminating, entrypoints focused, and conditional detail in linked references. Preserve automatic discovery unless the PM explicitly requests otherwise.
- Preserve the adoption/update exception: agent testing and remediation complete bootstrap without PM Testing or PM acceptance; retain PM gates for application work.
- Preserve exact-candidate approval, agent-owned Project movement, one active Issue, ambiguity questions, PM Testing steps, safe rollback, readback, and merge-not-completion invariants.
- Preserve [Issue-based communication](../../../AGENTS.md#issue-based-communication) across bootstrap instructions and skills: status and approval messages identify the Issue first, completion placeholders use its number, and pull requests remain critical supporting evidence. Keep approvals bound to the configured gate and exact candidate.
- Update the specification or blueprint before changing a contract. Add a failing behavioral test before changing tooling logic.
- Run the skill creator's `quick_validate.py` for every changed canonical skill, then `npm run check` and realistic dry-run or audit cases.
- Verify provider links against current official documentation when directory conventions may have changed.
- Keep human-facing standalone policy material as self-contained Dark Mode HTML and routine evidence in existing Issues, pull requests, checks, and concise chat.

Never weaken a safety or approval contract merely to satisfy a structural test.
