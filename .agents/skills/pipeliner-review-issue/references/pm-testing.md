# Full Showcase and PM Testing contract

A Showcase is the complete, approachable handoff for a specific Issue or aggregate release and current gate. Build it from the actual scope, diff, candidate and user journey. A generic smoke checklist or a bare approval phrase is insufficient. Adoption/update retain their Agent-only testing and acceptance exception; configure future application Showcases without demanding one for bootstrap.

Lead with the owning Issue number and outcome or remaining gate. Retain supporting PR/check links, and identify the current Agent Dev/Human PM pair. Aggregate release handoffs use the Release Issue number, all scoped changes and `scope=release`; development handoffs use `scope=issue`. Resolve approval placeholders from that Issue, never its PR.

The structured Showcase carries every field below; its human presentation must communicate the same substance. Use the exact types in the [evidence format](../../pipeliner-maintain/references/evidence.md), including arrays for prerequisites, test results, findings, regressions and limitations:

| Field | Required content |
|---|---|
| `scope`, `issue` | Issue or release scope and the owning Issue number. |
| `summary` | What changed, why it matters and the resulting behavior; aggregate scope for a Release Issue. |
| `findings` | Agent review findings and remediation outcomes. An empty array explicitly means no findings; state that in the handoff. Unresolved findings block readiness. |
| `testResults` | Actual tests/scenarios, results and evidence, including anything not run and why. |
| `target` | Exact current environment, URL, application, platform, source or artifact the Human will inspect. |
| `prerequisites` | Account, permissions, fixtures, data state, device/host and setup required. Agent handles routine authorized preparation. |
| `steps` | Numbered `PM Testing steps`, each with an `action` and observable `expected` result, covering changed behavior. |
| `regressions` | Focused failure, persistence, accessibility, compatibility and safety checks appropriate to the change. |
| `limitations` | Known limits and unavailable checks; explicitly state none when there are none. |
| `nextOutcome` | What this gate authorizes and what remains afterward: another pair, phase integration/promotion, Production authorization or final acceptance. |
| `approvalPhrase` | The exact configured phrase for this gate, in its own standalone fenced code block when approval is requested. |
| `candidate` | Exact stage-appropriate source commit, Git tree and configured artifact/configuration/deployment identity. Host/session evidence remains bound to its own environment. |

Also report current/next pair, latest-candidate coverage, suite/cleanup state, candidate availability and any retained resource with owner/cleanup trigger. Unavailable hosts and unresolved cleanup remain pending. Keep sensitive operational/session details in protected evidence.

Agent review, candidate preparation and tests precede Human approval. Agent tests support PM Testing and never substitute for an actual Human response. Use [message-only questions](../../pipeliner-maintain/references/questions.md) for clarification and approval, wait indefinitely and preserve answered questions. Never ask the PM to approve a future undeployed target or to perform routine agent-owned bookkeeping.

Use exactly `Approved` for every response. QA acceptance and its stated integration/closure outcome share one approval; never ask for an administrative confirmation afterward. Distinct environments, phase readiness or Production authorization may require their own scoped request. One response may be recorded as both paired QA and phase approval when the Showcase explicitly requests both for the same Human, scope and candidate; never manufacture a second Human response. Explain the next outcome without inventing a Production gate for tooling or a development Issue. On feedback, remediate the same Issue, keep the current pair through latest-candidate approval, then circulate to stale pairs; after merge use a fresh supporting PR routed to the owning phase branch. Follow [release-cycle governance](../../pipeliner-maintain/references/release-cycle.md) for scope, freeze, aggregate QA and final acceptance.
