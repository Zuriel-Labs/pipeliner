# Installed evidence formats

This reference matches `scripts/lib/qa.mjs`, `showcase.mjs`, `cleanup.mjs` and `release-cycle.mjs`. Field names below are JSON keys, not commands to execute. Evidence strings must identify real verification or actual Human responses; synthetic text passing a validator is never proof. Keep sensitive logs/session details protected. Helpers perform no GitHub mutation, deployment, authentication or command execution from evidence.

## CLI entrypoints

- `node scripts/resolve-home.mjs` takes **no arguments**. Invoke the installed script's absolute path from another directory. It anchors to its own file location and returns `root`, `repository`, `profilePath`; it does not resolve the caller's cwd. It checks AGENTS.md, profile and all fetch/push origin URLs. Current accepted transports are GitHub HTTPS, SCP-style Git SSH and SSH URL forms; alternate hosts, local remotes and credential-bearing URLs fail closed without echoing secrets.
- `node scripts/evaluate-qa.mjs <profile.json> <evidence.json>` requires a paired circulating profile, returns QA state and exits successfully only for `complete`. Legacy linear evaluation remains a library compatibility path for historical evidence, not permission to start new CLI QA.
- `node scripts/evaluate-release.mjs <profile.json> <evidence.json>` calls `evaluatePhase` and exits successfully only for `ready`. A waiting decision or invalid input is nonzero. Production authorization must be verified separately before mutation; the final production-phase evaluator is not a pre-deployment permission check.

## Circulating QA envelope and records

The envelope contains `candidate`, `records`, required `currentTurn` (a configured turn ID), required `issue` (positive safe integer), `scope` (`issue` or `release`; CLI defaults omitted scope to `issue`) and optional `cleanupResolutions` (defaults to `[]`). Use explicit scope for new evidence. Candidate identities are objects whose required keys contain nonempty strings with exact equality. For ordinary QA use `qa.candidateIdentity`; aggregate phase evaluation expands those keys as described below.

Each record contains:

| Key | Shape and passing requirement |
|---|---|
| `turn`, `round` | Known turn ID and positive safe integer; `(turn, round)` must be unique. Greatest round wins per turn, regardless of array order. |
| `developer`, `environment` | Exact IDs from the configured turn. |
| `candidate` | Exact current candidate under required identity keys. |
| `host` | `{available: true, os, architecture}` matching the configured environment. |
| `session` | Nonempty string identifying actual local validation. |
| `pickedUp`, `candidateAvailable` | Both `true` for verified pickup and availability. |
| `review` | `{candidate, evidence}` with matching identity and nonempty Agent review evidence. There is no separate `passed` flag in this object. |
| `suite` | Array exactly matching the environment's ordered suite, each `{command, exitCode: 0, evidence}`. Evidence is nonempty. Additional repository quality results belong in durable supporting evidence/Showcase, not extra entries in this exact array. |
| `showcase` | Full object defined below, bound to envelope scope/Issue/candidate and rendered turn approval phrase. |
| `pm` | `{owner, phrase, candidate, evidence}`: owner is the turn's Human PM ID; phrase is the configured turn phrase with every `{number}` replaced by the owning Issue number; candidate matches and actual-response evidence is nonempty. |
| `cleanup` | `{verified: true, evidence, resources}`. Evidence is nonempty; resources may be empty only when justified by actual inventory. Every listed resource has `kind` in `process/container/image/volume/workspace/artifact`, nonempty `id`, `run`, `owner`, `evidence`, and `status: removed`. |
| `nextCandidateAvailable` | `true` required when transferring from a completed current pair to a pending pair. It is not a substitute for incoming pickup. |

Retained resources can carry `cleanupTrigger` while pending, but cannot pass cleanup until removed and verified. **Every historical record's cleanup must also pass or have a valid cleanup resolution**, even when its candidate is stale. The evaluator scans configured order beginning at `currentTurn`, finishing that pair before moving to the next stale/incomplete pair. Update current ownership only after verified transfer; missing host, Human, Showcase or cleanup never counts as success. Legacy linear records remain historical only; explicit paired migration precedes any new sequence.

`cleanupResolutions` is an array of `{turn, round, cleanup}` entries. Each references one existing historical/current `(turn, round)` exactly once and supplies a passing cleanup object. For an unresolved record, its original `cleanup.resources` must exist and every original resource must appear in the resolution with exactly matching `kind`, `id`, `run` and `owner`; passing resolution entries have `status: removed` and verification evidence. Unknown rounds, duplicate resolutions or incomplete removal evidence fail. This appends later exact-resource cleanup proof without rewriting historical QA records, and never revives stale suite/PM approval. Both QA CLI options and aggregate release state pass this array to evaluation.

## Structured Showcase

| Key | Type |
|---|---|
| `scope` | `issue` or `release`, matching evaluation scope. |
| `issue` | Positive safe integer matching the owning Issue or Release Issue. |
| `candidate`, `approvalPhrase` | Matching candidate object and exact rendered turn phrase. |
| `summary`, `target`, `nextOutcome` | Nonempty strings. |
| `prerequisites`, `limitations` | Arrays of nonempty strings; empty arrays explicitly mean none. |
| `testResults`, `regressions` | Nonempty arrays of nonempty strings. |
| `findings` | Array of `{problem, remediation, evidence}`, all nonempty strings; `[]` explicitly means no findings. |
| `steps` | Nonempty array of `{action, expected}`, both nonempty strings. |

Use the [full human Showcase](../../pipeliner-review-issue/references/pm-testing.md) to present the same substance. Review findings must actually be remediated; the shape check does not authenticate that claim.

## Cycle profile

`release.cycle.phases` has at least two phases with unique nonempty IDs and unique literal branch names. First is `development`; last is the sole `production` phase; development cannot follow stabilization. Each phase declares `id`, `kind`, `branch`, nonempty unique `environments` naming `release.environments[].name`, nonempty unique `readiness` strings, nonempty `approvalPhrase`, `promotion` (`source`, `same-artifact`, `distinct-artifact`) and `forwardPortTo`.

`forwardPortTo` contains **phase IDs**, not branch names. Stabilization requires at least one unique existing development-phase ID. Development and production require empty arrays. An immutable-promotion strategy requires `same-artifact` for its production phase. `issueBranch(profile, {phase, kind})` accepts `kind=feature/fix/release` and returns `{base, forwardPort}` with branch names. It rejects unknown phases/kinds, stabilization features and production feature/fix routing. Without a cycle, omit phase; the helper returns the default branch and empty forward-port list. Scope membership/freeze authority still requires live verification beyond this pure branch helper.

## Aggregate `evaluatePhase` state

Pass this object directly as the release CLI's evidence JSON; there is no nested `qa` envelope. The required comparison keys are the union of `qa.candidateIdentity` and the stage keys: `release.preReleaseIdentity` (fallback sourceCommit/gitTree) for non-production, or `release.candidateIdentity` for production. Evaluation always adds derived `releaseScope` and, for any non-source promotion, also adds `artifactDigest` regardless of profile identity declarations. Thus every aggregate QA record and its review, Showcase and PM evidence bind the actual artifact, not only the phase approvals. Every identity below must match those keys unless specifically identified as a destination commit/tree.

Compute `candidate.releaseScope` with exported `releaseScopeKey(state)`: SHA256 hex digest of `JSON.stringify([state.releaseIssue, state.target, state.phase, numericallySortedIssueNumbers])`, where numbers come from `state.issues`. `frozenIssues` must exactly match that set. Evaluation recomputes and verifies the key. Include this same `releaseScope` in every aggregate record candidate, `review.candidate`, `pm.candidate`, `showcase.candidate`, verification candidate, each environment candidate, phase approval candidate, `artifact.candidate` and forward-port `sourceCandidate`. A target, phase, Release Issue or scoped Issue-set change requires newly bound evidence even if source/tree are unchanged; array ordering alone does not change the scope key. Do not fabricate new approvals by copying the new key into historical records.

| Key | Shape and ready requirement |
|---|---|
| `target` | Nonempty release target string; verify milestone identity/linkage live. |
| `releaseIssue` | Positive safe integer identifying the owning Release Issue. |
| `phase` | Configured phase ID. |
| `candidate` | Complete aggregate stage identity. Phase `kind=production` requires final identity from actual native distribution/integration or service deployment as configured; never invent a service deployment ID for native-only Stable. |
| `issues` | Nonempty array of `{number, accepted: true, evidence}`; unique positive safe integer Issue numbers, none equal to `releaseIssue`, with nonempty verified phase-acceptance evidence. |
| `frozenIssues` | Array containing exactly those scoped Issue numbers once each, no additions or omissions. Required for every evaluated aggregate phase. |
| `blockers` | Empty array for readiness; nonempty or missing blocks. |
| `readiness` | Exactly one `{criterion, passed: true, evidence}` per configured phase readiness string, with nonempty evidence. |
| `records`, `currentTurn` | Circulating QA records and configured current turn, evaluated internally with `scope=release`, `issue=releaseIssue` and aggregate identity keys. Every pair must pass. |
| `cleanupResolutions` | Optional array of exact `(turn, round)` cleanup resolutions as above, passed to aggregate QA without rewriting records. |
| `verification` | `{passed: true, evidence, candidate, environments}` with nonempty evidence and matching identity. Environments contains exactly one `{name, passed: true, evidence, candidate}` per configured phase environment, each matching the aggregate candidate. |
| `rollback` | `{target, evidence}`, both nonempty strings identifying known-good rollback and verification evidence. Required for every evaluated phase; resolve a legitimate source integration rollback where applicable. |
| `approvals` | Exactly one `{pm, phase, phrase, candidate, evidence}` per registered `qa.pms` Human. Phase is the current ID, phrase is its rendered `approvalPhrase`, candidate matches and actual-response evidence is nonempty. For artifact promotion also include `artifactDigest` as below. These are phase approvals, separate from each QA record's `pm`. |
| `forwardPorts` | Exactly one `{phase, verified: true, sourceCandidate, commit, gitTree, evidence}` per `forwardPortTo` ID. Source candidate matches aggregate identity; destination `commit`, `gitTree` and evidence are nonempty and verified live. Empty array for development/production. |
| `artifact` | For non-source promotion: `{digest, evidence, verified: true, candidate}` with nonempty strings and matching identity. `state.candidate.artifactDigest` must equal `artifact.digest`. `same-artifact` additionally requires `previousDigest === digest`. `distinct-artifact` additionally requires nonempty string `channelInputs`. Every phase approval must include `artifactDigest === artifact.digest`. |

The result is `{state: waiting, reason}` or `{state: ready, phase, next, reason}` with `next` the next phase ID or `null` after the last phase. Structural errors can throw and the CLI reports failure. `next: null` does not close an Issue. Artifact fields model one current phase artifact, not an array of platform binaries; additional per-platform evidence remains independently governed and must not be represented as one identical binary.

When an actual Production destination exists, Production authorization against pre-release identity is an agent-verified prerequisite **outside** `evaluatePhase`. A final `kind=production` phase may instead use `multi-environment` with native-only Stable distribution; phase environment names may reference `role=native` environments. Follow configured native distribution/integration authorization and verification without invoking `pipeliner-release-production` or inventing a service URL. After the applicable authorized delivery, record final identity and run aggregate QA, verification and every Human's final phase approval. Exact completion acceptance remains required. Preserve original QA records across intended exact-tree/artifact transitions and create separate stage evidence; do not edit history to claim tests of a new merge SHA or deployment.
