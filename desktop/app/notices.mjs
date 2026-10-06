// Display-only classification. Authority and candidate evidence remain in the host.
export function createDevelopmentNotices() {
  const seen = new Map();
  return Object.freeze({ observe(snapshot, enabled = true) {
    const { workspaceId, run, development, qa, error } = snapshot ?? {};
    if (typeof workspaceId !== 'string' || !workspaceId || typeof run?.id !== 'string' || !run.id || !Number.isSafeInteger(run.issue) || run.issue < 1) return null;
    const kind = error ? 'failure' : qa ? qa.decision !== 'approve' && typeof qa.hash === 'string' && qa.hash.length <= 128 ? 'action' : null : development?.state === 'candidate' ? 'ready' : null;
    if (!kind) return null;
    const key = JSON.stringify([workspaceId, run.id]), event = kind + (kind === 'action' ? ':' + qa.hash : '');
    const events = seen.get(key) ?? new Set();
    if (events.has(event)) return null;
    events.add(event); seen.delete(key); seen.set(key, events);
    if (events.size > 100) events.delete(events.values().next().value);
    // Session-local optional notices do not retain an unbounded run history.
    if (seen.size > 100) seen.delete(seen.keys().next().value);
    if (!enabled) return null;
    return { target: workspaceId, title: 'Issue #' + run.issue + ' · ' + ({ failure: 'Development needs attention', action: 'PM Testing is ready', ready: 'Candidate is ready' }[kind]), kind };
  } });
}
