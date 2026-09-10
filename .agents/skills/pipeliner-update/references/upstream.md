# Upstream identity and applied provenance

The default framework source is `https://github.com/Zuriel-Labs/pipeliner`. Use an explicitly configured, verified fork when the adopter intentionally selected one; do not confuse the application's remote with the framework remote. Verify repository identity and default branch through GitHub and Git. Resolve requested branches or tags to full commit SHAs before review. An inaccessible source is unknown, never evidence of no update.

Read an existing `.agents/pipeliner-source.json` when present. This is target-owned evidence, not a file copied from upstream. After a successful adoption or update, agents may maintain this version 1 record containing:

- `version`: 1;
- `repository`: verified framework clone URL;
- `ref`: selected upstream tracking branch or tag;
- `commit`: full applied upstream commit SHA;
- `appliedAt`: UTC timestamp of verified installation;
- `exceptions`: managed paths and concise reasons for deliberately retained local differences.

Write it only after the installed contract has been reconciled and locally validated, then publish it with the same target change. A monitor reads the record from the target's default branch; an unmerged update record must not be treated as the deployed/default installation. The record identifies the framework revision whose contract was incorporated, not byte equality of all customized files. Keep target commit/tree evidence in the maintenance result and any required supporting PR; do not create an Issue for provenance. Never put secrets in provenance.

For legacy adopters, inspect repository history and prior adoption evidence. If an applied SHA cannot be established, leave it unknown. Do not set the current upstream SHA as applied merely because it is reachable or was checked. An update can establish a new baseline after verified reconciliation. A check or monitor must never change the applied baseline.

For detection, compare immutable commits and ancestry: equal means no newer upstream revision relative to the recorded baseline; an upstream descendant means a new revision is available; divergence or a rewind requires review rather than an assumed upgrade. If the user tracks a fixed tag or commit, clarify the intended update channel before monitoring for newer releases. Track the last observed/notified SHA and failure state separately in scheduler-owned persistent state so notifications can be deduplicated. Where the scheduler lacks durable state, disclose that limitation before enabling a monitor that promises deduplication.

Bootstrap copying includes the canonical skills and references, but not `scripts/adopt.mjs`; run the installer from the reviewed upstream source checkout. Existing adopters get these skills only through an intentional update, not automatic synchronization.
