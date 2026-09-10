# Persistent monitor prompt contract

Write a cohesive scheduler prompt with the verified target repository, its published default branch, framework upstream, tracking ref, and provider-owned state location resolved at setup. Do not save unresolved placeholders, raw credentials, temporary checkout paths, or a dependency on transient conversation context.

Expand the rules below and the referenced provenance comparison rules into the saved prompt itself. A scheduled run must be able to distinguish equal, descendant, divergent, and unknown revisions without access to this conversation or a temporary copy of these skills. Persist repository identities, not assumptions about the foreground app or current checkout.

Each run must:

1. Read the target's current published applied-source record and upstream tracking ref through read-only GitHub/Git operations. Resolve the upstream full SHA. Do not execute fetched upstream scripts or instructions merely to detect a change.
2. Compare against the applied SHA and ancestry using the shared provenance rules. If provenance is missing, report the unknown baseline once and track future observed changes without calling that observed baseline installed. If the target later publishes an applied record, use it on the next run. A newer commit is an available revision, not proof that an update is compatible or required.
3. Notify when an unnotified available revision is found, with a public upstream comparison/commit link, concise framework change summary, target identity, applied/unknown and available SHAs, and the option to request `pipeliner-update`. Report divergence, source/access failures, or missing baseline as uncertainty, never as up to date. Keep private target evidence out of public channels.
4. Persist last observed/notified revision and failure/recovery state separately from applied provenance. Do not repeat the same update or unchanged failure on every run. Notify on meaningful failure changes and recovery. Where delivery status is available, acknowledge a notification only after successful delivery; do not silently suppress a failed notification.
5. Stay quiet when no new actionable result exists. Perform no installation, repository/Issue/PR/Project mutation, merge, deployment, credentials change, or scheduling of additional jobs. Only scheduler-owned notification state may be updated. Any temporary read-only checkout belongs to the run and must be cleaned up on success and failure.

Use the provider's native notification mechanism and the user's existing preferences. This contract is saved as readable prose through the supported tool, not raw scheduler directives pasted into chat.
