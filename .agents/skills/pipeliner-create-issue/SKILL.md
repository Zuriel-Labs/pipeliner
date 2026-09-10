---
name: pipeliner-create-issue
description: Research, clarify, draft, create, classify, and verify one implementation-ready GitHub Issue without starting implementation.
---

# Create an Issue

Apply the shared [installed repository home](../pipeliner-maintain/references/home.md) and [message-only questions](../pipeliner-maintain/references/questions.md) contracts. First adoption retains its explicit-target gate.

Follow [Issue-based communication](../../../AGENTS.md#issue-based-communication): identify the proposed work by its draft title until GitHub assigns an Issue number, then use that Issue number in status and handoffs. Keep the exact draft-creation approval gate; never predict a number or substitute an existing PR number.

Read `AGENTS.md`, `pipeliner.config.json`, the live Project, every relevant open or closed Issue, open pull requests, and implicated repository evidence.

1. Determine whether the request is one coherent, independently verifiable outcome. Split unrelated goals and identify duplicates, absorbed scope, dependencies, and already-delivered behavior.
2. Resolve material ambiguity from repository evidence. When evidence is insufficient, ask focused questions with tradeoffs and a recommended default only in ordinary messages marked `Question:`. Wait indefinitely for required answers without timers or inferred defaults; preserve existing answers. Do not invent product behavior.
3. Draft an imperative title and complete HTML body using only applicable sections: Summary, Context and evidence, Scope, Acceptance criteria, Verification, Security and privacy, Accessibility, Dependencies, and Out of scope.
4. Propose exactly one governed type label, applicable area labels, Status, Priority, Impact, Effort, assignee, and milestone. Default new work to open, unassigned Backlog unless the PM approves a different valid state.
5. Show the complete title, body, and metadata before mutation. Put each value the PM needs to copy in its own fenced code block. Require the exact configured Issue-creation approval for that draft.
6. Refresh duplicate and Project state immediately before creating. Use `gh` to create only the approved Issue, add it to the configured Project, populate fields, and leave the active slot untouched.
7. Read the Issue and card back. Byte-compare the body and verify title, labels, fields, open state, assignment, Project membership, Backlog status, and absence of an accidental branch or pull request.

Issue creation never authorizes implementation, release, or changes to another Issue.

When `release.cycle` is configured, follow [release scope and phase governance](../pipeliner-maintain/references/release-cycle.md): inspect target/milestone, Release Issue, phase, freeze and blockers without treating phase as Status. Read-only inspection never starts or advances a cycle. Related findings stay on the same Issue; unrelated intake requires exact draft approval.
