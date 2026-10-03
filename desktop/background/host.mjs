const states = ['not-registered', 'enabled', 'requires-approval', 'not-found'];

// One foreground/background owner. Native registration never creates a second executor path.
export function createBackgroundHost({ policy, native, pause, resumeChecks = async () => {}, onChange = () => {} }) {
  let visible = true, sleeping = false, closed = false, blocked = false, pending = null, cleanupPending = false, error = null, authorizationPaused = false;
  const intent = () => { const v = policy?.worker.read(null).values; return { configured: v?.['background.enabled'].value ?? false, startAtLogin: v?.['background.startAtLogin'].value ?? false }; };
  function inspect() {
    try { const value = native.inspect(); if (typeof value.qualified !== 'boolean' || !states.includes(value.status)) throw new Error(); return value; }
    catch { return { qualified: false, status: 'not-found' }; }
  }
  function status() { const desired = intent(), actual = inspect(); return { ...desired, qualified: actual.qualified, authorization: actual.status,
    effective: !closed && !sleeping && !blocked && desired.configured && actual.qualified && actual.status === 'enabled',
    visible, sleeping, busy: Boolean(pending), cleanupPending, error }; }
  const publish = () => { if (!closed) onChange(status()); };
  let observation = JSON.stringify(inspect());
  function serialize(work) {
    if (closed) throw new Error('Background host closed.'); if (pending) return pending;
    pending = Promise.resolve().then(work).finally(() => { pending = null; publish(); }); publish(); return pending;
  }
  async function pauseSafely() { blocked = true; publish(); try { await pause(); } catch { cleanupPending = true; error = 'pause-unverified'; throw new Error('Background pause remains unverified. Work is preserved.'); } }
  return Object.freeze({ status,
    setVisible(value) { if (typeof value !== 'boolean') throw new Error('Background visibility invalid.'); visible = value; publish(); },
    executionAllowed() { const s = status(); return !closed && !sleeping && !blocked && (visible || s.effective); },
    loginAllowed() { const s = status(); return s.configured && s.startAtLogin && s.qualified && s.authorization === 'enabled'; },
    reconcile() {
      blocked = true; publish();
      return serialize(async () => {
        error = null; const desired = intent(), actual = inspect();
        if (desired.configured) {
          if (!actual.qualified) { blocked = true; error = 'package-unqualified'; throw new Error('Signed background package unavailable.'); }
          if (['not-registered', 'not-found'].includes(actual.status)) {
            blocked = true;
            try { await native.register(); } catch { if (inspect().status !== 'enabled') { error = 'registration-unverified'; throw new Error('Background registration remains unverified.'); } }
          }
          const result = inspect(); if (!result.qualified || !['enabled', 'requires-approval'].includes(result.status)) { blocked = true; error = 'registration-unverified'; throw new Error('Background registration remains unverified.'); }
          blocked = false; cleanupPending = false; authorizationPaused = false;
        } else {
          await pauseSafely();
          if (actual.status !== 'not-registered' && actual.qualified || cleanupPending) {
            try { await native.unregister(); } catch { if (inspect().status !== 'not-registered') { cleanupPending = true; error = 'removal-unverified'; throw new Error('Background unregister remains unverified.'); } }
            if (inspect().status !== 'not-registered') { cleanupPending = true; error = 'removal-unverified'; throw new Error('Background unregister remains unverified.'); }
          }
          blocked = false; cleanupPending = false; authorizationPaused = false;
          if (visible && !sleeping) await resumeChecks();
        }
      });
    },
    refresh() {
      const before = status(), nextObservation = JSON.stringify(inspect()), changed = nextObservation !== observation; observation = nextObservation;
      if (!(before.configured && (!before.qualified || before.authorization !== 'enabled') && !authorizationPaused)
        && !(before.qualified && before.authorization === 'enabled' && !cleanupPending && (authorizationPaused || blocked || error))) {
        if (changed) publish(); return Promise.resolve();
      }
      return serialize(async () => {
        const s = status();
        if (s.configured && (!s.qualified || s.authorization !== 'enabled') && !authorizationPaused) {
          await pauseSafely(); authorizationPaused = true; blocked = cleanupPending; error = s.authorization === 'requires-approval' ? 'authorization-required' : 'authorization-unavailable';
          if (visible && !sleeping && !cleanupPending) await resumeChecks();
        }
        if (s.qualified && s.authorization === 'enabled' && !cleanupPending) { authorizationPaused = false; blocked = false; error = null; if (!sleeping) await resumeChecks(); }
      });
    },
    suspend() { sleeping = true; blocked = true; publish(); return serialize(async () => { await pauseSafely(); blocked = cleanupPending; }); },
    async wake() { if (pending) await pending; if (cleanupPending) throw new Error('Background pause remains unverified.'); sleeping = false; blocked = false; await this.refresh(); publish(); },
    openSettings() { if (closed || !inspect().qualified) throw new Error('Background authorization unavailable.'); return native.openSettings(); },
    close() { closed = true; blocked = true; },
  });
}
