'use strict';
// Qualification only. Packaged startup rejects qualification and excludes this module.
const phases = new Set(['helper-build-started', 'helper-build-finished', 'app-launch-started', 'main-ready', 'host-modules-ready',
  'window-created', 'window-load-started', 'window-load-finished', 'window-ready-to-show', 'window-load-failed',
  'vault-started', 'vault-ready', 'protected-state-ready', 'protected-state-unavailable', 'qualification-started', 'qualification-finished',
  'shutdown-started', 'shutdown-finished', 'main-failed']);
function progress(text) {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 512) return null;
    const value = JSON.parse(text); if (!value || Array.isArray(value) || typeof value !== 'object') return null;
    const keys = Object.keys(value).sort().join(',');
    if (keys === 'desktopPhase,milliseconds' && phases.has(value.desktopPhase) && Number.isSafeInteger(value.milliseconds)
      && value.milliseconds >= 0 && value.milliseconds <= 600000) return value;
    if (keys === 'desktopCheck,stage' && Number.isSafeInteger(value.desktopCheck) && value.desktopCheck >= 1 && value.desktopCheck <= 256
      && ['started', 'passed', 'failed'].includes(value.stage)) return value;
  } catch { /* Child payloads never cross the public fixture-log boundary. */ }
  return null;
}
exports.progress = progress;
exports.phase = (name, milliseconds) => {
  const value = progress(JSON.stringify({ desktopPhase: name, milliseconds: Math.round(milliseconds) }));
  if (!value) throw Error('qualification-progress-invalid'); console.log(JSON.stringify(value));
};
