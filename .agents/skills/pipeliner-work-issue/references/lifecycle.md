# Agent-led routing

Read the live Issue, Project, matching PR(s), candidate and actual PM messages. Use the profile's Status names. `scripts/lib/lifecycle.mjs` exposes read-only helpers over verified inputs; they do not replace evidence or authorize actions.

## Requests and continuation

- Start/work with an Issue number: honor that Issue unless another is active. Start/work without a number: continue the sole active Issue; otherwise select ready Backlog work by the profile's priority option order, then lowest Issue number. Read all relevant pages and dependencies first. Missing readiness, priority or conflicting active state is unresolved, not permission to choose around it. `selectWork(profile, {issues, requested, intent})` accepts records with number, state, mapped status, priority and evidence-backed boolean ready. Read-only intent never starts work. Explicit On Hold resumption must be resolved before using the Backlog selection path.
- Review: use `pipeliner-review-issue` for the active Issue whether In Progress or In Review. If the user asks to review a specific inactive Issue, clarify audit versus starting its lifecycle; do not activate it as an incidental review action.
- Publishing a PR: invoke review yourself. Completing agent review: prepare the applicable candidate and guide the PM through the next required testing/approval gate. Approved unchanged candidate: perform the next authorized transition yourself. Feedback: remediate on the same Issue and retest; no extra start/review command is needed.
- Before asking a material question or requesting required PM Testing/approval, finish necessary evidence recording and task-owned cleanup. Then send the final ordinary message and end the turn immediately; no task work or tool calls follow until the Human replies. Missing access/compatible hosts or repository controls may permit independent authorized work before that question. Do not start another Issue after completion unless requested.

## Questions and approval

Follow [message-only questions](../../pipeliner-maintain/references/questions.md): use final ordinary messages marked `Question:`, never native question controls. Preserve answers and end the turn until the Human replies; `clarificationDecision` returns `endTurn: true` for an unanswered question with no deadline or auto-answer behavior. It evaluates supplied inputs and cannot enforce provider execution. Tool timeouts never supply a PM response.

Approval requests show the exact candidate and configured phrase in a standalone code block. An approval belongs to that gate and unchanged candidate. A test pass, recommended answer, previous candidate's approval or absence of feedback never substitutes for actual approval. Do not use tools to contact other PMs without explicit authorization; use available authorized coordination channels and report the required owner's pending turn.

## Resumed review and feedback

`reviewRoute` accepts the mapped active Status and OPEN/MERGED PR state plus whether actual findings exist. OPEN routes to review/remediation. MERGED without findings routes to checking release/acceptance evidence: verify any pending authorized release before PM acceptance, never presume deployment succeeded. MERGED with findings routes to a fresh remediation PR. Unknown/closed-unmerged PR state blocks for diagnosis.

Move the same Issue to In Progress before remediation. Before merge, use its existing supporting branch. After merge, resolve the owning phase branch using [release-cycle routing](../../pipeliner-maintain/references/release-cycle.md), or the current default branch without a cycle, and start there using a fresh suffix on the configured Issue branch pattern, create a new supporting PR with the same non-closing Issue reference, and retain the prior release/PR as history. Never try to push fixes into an already merged PR or reopen a completed Issue silently. Invalidate affected evidence, repeat configured QA and obtain fresh approvals.

## Release progression

Resolve [installed home](../../pipeliner-maintain/references/home.md), then any configured [cycle](../../pipeliner-maintain/references/release-cycle.md) before simple strategy routing. `issueBranch(profile, {phase, kind})` returns the permitted base and forward-port branches for `kind=feature/fix/release`; unknown phases, frozen features and production feature/fix routing are rejected. Production findings enter governed development/stabilization. Development Issue integration does not require Production. Aggregate phase readiness belongs to the Release Issue. Final `kind=production` can be native Stable distribution: use candidate preparation and configured distribution verification through review/close, with aggregate all-PM acceptance. Only an actual configured Production destination invokes the Production skill and its separate mutation authorization.

Follow the matching [strategy](../../pipeliner-release-candidate/references/strategies.md) in order. `releaseStages(strategy, {hasProduction})` lists the ordered milestones; `identityKeys(profile, phase)` selects `pre-release` or `released` identity. Agents verify prerequisites, PM ownership, source and artifacts independently; milestone lists are not a security enforcement engine.

Local QA is independent of release topology. Build/prepare the artifact needed for PM Testing before requesting its approval. Agent review and candidate preparation can occur while local PM turns remain pending; In Review still requires those turns and cleanup complete. Avoid calling candidate preparation repeatedly on resumption when the exact artifact is already verified. Keep cleanup inventories and retain only declared resources until PM Testing ends.
