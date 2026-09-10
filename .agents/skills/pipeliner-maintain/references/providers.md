# Provider discovery and portable adapters

Canonical authority remains `AGENTS.md` and exactly 12 packages under `.agents/skills/`. References are supporting instructions, not additional skills. Resolve adapter links to their installed canonical package and then use [home resolution](home.md). Provider discovery does not authorize a different repository or relax [message-only questions](questions.md).

Official documentation checked on 2026-09-10:

- [OpenCode Agent Skills](https://opencode.ai/docs/skills) documents project `.agents/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md` and `.opencode/skills/<name>/SKILL.md` discovery. Its project search walks toward the Git worktree boundary; name and description frontmatter identify a skill. Use the canonical `.agents` installation rather than copying policy into another tree. Check duplicate-name precedence and actual runtime permissions locally before claiming successful loading.
- [Claude Code skills](https://code.claude.com/docs/en/skills) documents project `.claude/skills/<name>/SKILL.md` and supporting files. Keep Pipeliner's Claude packages as thin regular-file adapters pointing to the canonical package. [Claude memory imports](https://code.claude.com/docs/en/memory) documents imports from `CLAUDE.md`; retain the root import of `AGENTS.md`. Do not duplicate full workflow policy or replace portable files with symlinks.

For Codex/ChatGPT and other providers, inspect their actual available skill catalog and supported repository instruction/import mechanism. Keep the smallest supported adapter, preserve automatic discovery unless explicitly changed, and distinguish source-documentation verification from live provider execution. A valid Markdown link or successful structural check does not prove that a provider discovered, loaded or followed a skill. Report untested providers and permission limits explicitly.

## Issue #9 check results and remaining execution checks

Local inspection on 2026-09-10 found exactly 12 canonical skill entrypoints and 12 ordinary-file Claude adapters; every adapter link resolves to its matching canonical skill, and `CLAUDE.md` imports `AGENTS.md`. All 12 canonical skills passed `quick_validate.py`, and local documentation links resolved. These are file/contract checks, not live provider runs; repeat them in an adopter after reconciliation.

OpenCode's official discovery locations support using the canonical installation directly. A remaining live check is to open an adopted repository in OpenCode, inspect its available skill list for duplicate names or permission restrictions, load a Pipeliner skill and verify that it reads the installed canonical home. For Claude Code, inspect the available skill list, load a thin adapter, verify the canonical reference is followed and confirm the root instructions are read. In both, exercise a read-only home/audit request from a nested directory and verify message-only clarification. No live OpenCode or Claude execution was performed for this documentation slice; other provider execution is also unverified.
