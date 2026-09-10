# PM Testing contract

Build the checklist from the actual Issue, diff, candidate, and user journey. Do not reuse a generic smoke list as a substitute for changed-behavior coverage.

Lead the handoff and approval acknowledgment with the owning Issue number and its current gate. Include the linked pull request as supporting evidence alongside exact candidate identity. Resolve `{number}` from the Issue: for Issue #42 implemented by PR #57, the default completion request is `Approved to complete Issue #42`. Preserve other configured gate phrases and explicitly bind them to the Issue and unchanged candidate; completion approval never authorizes a different candidate or skips pending gates.

Include:

1. exact target URL, application, platform, build, or artifact;
2. candidate source commit, Git tree, artifact or deployment identity, and validation session where configured;
3. prerequisite account, permissions, fixtures, data state, browser, device, or native host;
4. numbered actions in the order the PM should perform them;
5. an observable expected result paired with every action;
6. relevant failure, regression, accessibility, persistence, and safety checks;
7. known limitations or checks the agent could not perform;
8. the one exact approval phrase for this gate in a standalone fenced code block.
9. each required local QA environment and its developer/PM owner, current and next turn, suite state, candidate availability, and any PM-retained resource with cleanup owner and trigger. An unavailable host or unverified cleanup remains pending.

Use `Project Manager QA` or `PM Testing`. Keep the language approachable and explain product terms that are not obvious. Agent test evidence supports the checklist but never approves it.
