import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { record } from '../core/settings.mjs';

const shapes = {
  'agent-ready.json': ['nonce','pid','window','buttonX','buttonY','neighborReadDenied','neighborWriteDenied','readOnlyWriteDenied','escapeLinkReadDenied','descendantDenied','targetBundle','signatureVerified','actualGuestWindowVerified'],
  'agent-result.json': ['nonce','clicked','guestLaunchEscapeContained'],
  'agent-stop.json': ['nonce','targetStopped','ownedGuestInstallRemoved'],
  'escape-launch.json': ['nonce','launchedInGuest','pid'],
  'returned-link.json': ['nonce','clicked','guestLaunchEscapeContained'],
  'agent-started.json': ['nonce','started'],
  'agent-failed.json': ['nonce','failed'],
};
// Qualification evidence only. A guest result cannot select or authorize a host operation.
export async function readGuestReport(directory, name, nonce) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !Object.hasOwn(shapes,name) || !/^[a-f0-9]{32}$/.test(nonce)) throw new Error('bridge-report-context-unqualified');
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid() || (root.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) throw new Error('bridge-output-root-unqualified');
  const file = await open(join(directory,name),constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.size < 1 || info.size > 16384) throw new Error('bridge-output-file-unqualified');
    const bytes = Buffer.alloc(info.size); const result = await file.read(bytes,0,bytes.length,0);
    if (result.bytesRead !== bytes.length) throw new Error('bridge-output-read-unqualified');
    const after = await file.stat(), current = await lstat(join(directory,name)), currentRoot = await lstat(directory);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.nlink !== 1
      || current.dev !== info.dev || current.ino !== info.ino || current.nlink !== 1 || current.isSymbolicLink()
      || currentRoot.dev !== root.dev || currentRoot.ino !== root.ino || currentRoot.isSymbolicLink()) throw new Error('bridge-output-changed');
    const value = JSON.parse(bytes.toString('utf8')); record(value,shapes[name]);
    if (value.nonce !== nonce) throw new Error('bridge-output-stale');
    for (const [key,item] of Object.entries(value)) {
      if (key === 'nonce') continue;
      if (key === 'failed') { if (!['guest-install-directory','guest-install-integrity','guest-launch-identity','guest-action-incomplete'].includes(item)) throw new Error('bridge-failure-unqualified'); }
      else if (key === 'targetBundle') { if (item !== `/Users/pipeliner/Library/Caches/pipeliner-54-app-${nonce}/Target.app`) throw new Error('bridge-target-unqualified'); }
      else if (['pid','window'].includes(key)) { if (!Number.isSafeInteger(item) || item < (key === 'pid' ? 2 : 1)) throw new Error('bridge-window-unqualified'); }
      else if (['buttonX','buttonY'].includes(key)) { if (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item >= (key === 'buttonX' ? 1024 : 768)) throw new Error('bridge-point-unqualified'); }
      else if (typeof item !== 'boolean') throw new Error('bridge-result-type-unqualified');
    }
    return value;
  } finally { await file.close(); }
}
