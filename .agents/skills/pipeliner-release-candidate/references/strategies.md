# Release strategies

Read only the section selected by `release.strategy`.

## `immutable-promotion`

- Build the exact pull-request candidate once in the configured trusted build environment.
- Record source commit, Git tree, immutable artifact digest, rendered configuration, and review deployment revision as configured.
- Deploy the digest to the review environment through its declared source of truth and verify it there.
- Obtain the configured exact pre-Production approval for this candidate.
- Production must reuse the identical digest without rebuilding. A source, dependency, image, migration, rendered configuration, or included documentation change creates a new candidate.

## `direct-production`

- Candidate review happens through local testing, CI, exact tree identity, and any configured preview—not through an invented Canary.
- Merge only the exact reviewed tree using the repository's approved merge method.
- Deploy the exact clean default-branch revision, record the previous Production version, and verify the new Production identity and behavior.
- Keep the Issue In Review after a healthy deployment. Project Manager QA occurs against Production; only the configured completion approval permits Done and closure.

## `multi-environment`

- Commit the complete candidate before building the environment-specific artifact.
- Each required native host or environment runs its own configured gates, build, launch, checklist, and PM Testing session against the exact candidate.
- Approval is bound to the candidate, environment, platform, and validation session. One environment cannot approve another.
- Code remediation creates a new candidate and returns it through every affected environment. Do not merge until the configured independent review and hand-back loop is complete.

## `none`

No application release exists. Use source commit and Git tree as the candidate, require configured quality checks, and complete only through the repository's documented review and PM acceptance policy.
