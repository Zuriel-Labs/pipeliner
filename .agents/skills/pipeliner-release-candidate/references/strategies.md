# Release strategies

Read only the section selected by `release.strategy`.

## Identity and approval stages

`release.preReleaseIdentity` lists the exact identity available at the pre-merge/release authorization gate; `release.candidateIdentity` lists final released identity. Each includes sourceCommit/gitTree and pre-release keys must be a subset of final keys. Record every key at its applicable stage, including artifact/configuration when it affects the approved candidate. Do not fabricate future deployment values.

For legacy none/direct-production profiles without preReleaseIdentity, pre-release keys default to sourceCommit/gitTree; preserve stronger existing artifact/configuration approval requirements during reconciliation. For legacy immutable/native profiles, default conservatively to the complete candidateIdentity. If it mixes future Production-only identity with review identity, resolve stage ownership from authoritative release configuration or ask before mutation. New adoption explicitly classifies the keys and must not silently drop stronger evidence.

An expected merge can change sourceCommit while preserving the exact reviewed gitTree; promotion can create a distinct deployment revision while retaining the approved artifact. Capture both stage records and prove continuity. Only those intended transitions preserve the gate authorization. Any unexpected tree/artifact/configuration change invalidates it. Never transfer a native session approval between hosts. Pre-release Production authorization never substitutes for final completion acceptance.

Use workflow.approvalPhrases.production for Production mutation and workflow.approvalPhrases.completion for final acceptance. Review/native environment approvalPhrase applies to that prepared environment; if the configured review phrase is the Production phrase and the handoff explicitly binds both gates to the same candidate, one response can cover them. A Production environment's approvalPhrase may describe pre-release authorization or post-release completion (existing profiles use both); resolve it by these configured phrases. Conflicting custom wording requires discovery rather than guessing a new gate or changing the phrase.

## `immutable-promotion`

- Complete agent code review, then build the exact committed pull-request candidate once on the configured compatible local host.
- Record source commit, Git tree, immutable artifact digest, rendered configuration, and review deployment revision as configured.
- Deploy the digest to the review environment through its declared source of truth and verify it there.
- Complete configured independent local QA turns and cleanup, then obtain the configured exact pre-Production approval for this verified candidate. Preparing the review artifact does not require its PM approval first.
- Production must reuse the identical digest without rebuilding. A source, dependency, image, migration, rendered configuration, or included documentation change creates a new candidate.
- Merge the exact reviewed tree, promote the same digest, record final deployment identity and verify Production. Guide final PM Testing and request the configured completion phrase before closing. No repeated skill trigger is needed.

## `direct-production`

- Candidate review happens through local testing, CI, exact tree identity, and any configured preview—not through an invented Canary.
- Complete configured local QA turns and cleanup, then request workflow.approvalPhrases.production against the pre-release source/tree and any configured prebuilt artifact. This authorizes the planned merge/deploy; it is not acceptance of a future Production deployment. No invented Canary or deployment ID.
- After actual authorization, merge only the exact reviewed tree using the repository's approved merge method.
- Deploy the exact clean default-branch revision, record the previous Production version, and verify the new Production identity and behavior.
- Keep the Issue In Review after a healthy deployment. Project Manager QA occurs against Production; only the configured completion approval permits Done and closure.

## `multi-environment`

- Commit the complete candidate before building the environment-specific artifact.
- Each required native host or environment runs its own configured gates, build, launch, checklist, and PM Testing session against the exact candidate.
- Approval is bound to the candidate, environment, platform, and validation session. One environment cannot approve another.
- Code remediation creates a new candidate and returns it through every affected environment. Do not merge until the configured independent review and hand-back loop is complete. Prepare each required artifact before asking for its native/environment approval; do not wait for that approval to build it.
- After native approvals and cleanup, merge the exact tree. If Production is configured, obtain its authorization before integration/deployment and verify that release. Otherwise verify configured native distribution/source integration without invoking Production. Guide final acceptance against the actual native/released identity, then close on the completion phrase.

## `none`

No application release exists. Complete agent review and configured local QA/cleanup against the committed source/tree. Guide PM Testing of the source/tooling behavior, request the configured completion phrase, then merge the exact reviewed tree, record the resulting source revision and close after readback. Do not invoke Production or ask for a nonexistent deployment ID. No repeated completion approval is needed for that exact-tree merge. A different tree requires fresh QA and approval.
