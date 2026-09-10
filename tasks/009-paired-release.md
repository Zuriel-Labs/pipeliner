# Issue #9 implementation plan

1. Specify shared contracts and compatibility; add behavioral regression tests.
2. Implement home resolver, message decisions, typed participants and Showcase validation.
3. Implement rotating QA history/current-owner evaluation and CLI support.
4. Implement optional release-cycle validation, branch routing and phase readiness evidence.
5. Align schema, profile examples, installer discovery, canonical skills/references and Dark Mode policy.
6. Validate adoption matrices, provider references, cleanup and CI command graph; remediate review findings.
7. Publish exact candidate PR with Refs #9, verify checks and give the PM a complete tooling Showcase. Do not merge or close before the configured gate.

## Verification record
- Implemented steps 1–6 with behavioral regressions and installed CLI fixtures.
- Independent Agent review found and remediated conflicting artifact digests, immutable-strategy mismatch, release-scope approval reuse, historical cleanup resolution and malformed phase entries.
- Local suite: 68 tests passed, repository validation and whitespace checks passed. Synthetic multi-host/provider scenarios are not live native or provider executions.
- No app processes, containers or builds were started. Test fixtures use exact temporary roots and teardown hooks.
- Publication and current-candidate PM Testing remain step 7; Issue #9 stays In Progress until the local Human approval gate and cleanup are recorded.
