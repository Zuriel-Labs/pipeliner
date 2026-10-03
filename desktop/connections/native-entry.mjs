import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { endpointURL } from '../tools/transport.mjs';

function nativeEntry(helper, directory, signal, args) {
  const file = lstatSync(helper);
  if (file.isSymbolicLink() || !file.isFile() || file.uid !== process.getuid() || (file.mode & 0o022) || realpathSync(helper) !== resolve(helper)) throw new Error('native-entry-failed');
  signal?.throwIfAborted();
  return new Promise((resolveEntry, reject) => {
    const child = spawn(helper, args, { env: { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', oversized = false, launchFailed = false, nativeException = null, selector = null;
    child.stderr.on('data', bytes => {
      const text = bytes.toString();
      nativeException ??= /uncaught exception '([A-Za-z0-9_]+)'/.exec(text)?.[1] ?? null;
      selector ??= /(-\[[A-Za-z0-9_]+ [A-Za-z0-9_:]+\]): unrecognized selector/.exec(text)?.[1] ?? null;
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { if (Buffer.byteLength(output) + Buffer.byteLength(data) > 16384) { oversized = true; child.kill('SIGTERM'); } else output += data; });
    const abort = () => child.kill('SIGTERM'); signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => { launchFailed = true; });
    child.on('close', (code, exitSignal) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted || code === 143) { reject(new Error('native-entry-cancelled')); return; }
      if (code !== 0 || oversized || launchFailed) { reject(new Error('native-entry-failed', { cause: { stage: 'process', code, signal: exitSignal, oversized, launchFailed, nativeException, selector } })); return; }
      try {
        const value = JSON.parse(output); output = '';
        if (value.cancelled) { reject(new Error('native-entry-cancelled')); return; }
        resolveEntry(value);
      } catch { reject(new Error('native-entry-failed', { cause: { stage: 'json', bytes: Buffer.byteLength(output) } })); }
    });
  });
}

export async function nativeKeyEntry(helper, directory, signal, qualify = false) {
  const value = await nativeEntry(helper, directory, signal, qualify ? ['--qualify', join(directory, 'secure-field.png')] : []);
  if (typeof value.key !== 'string' || value.key.length < 8 || value.key.length > 512 || /\s|[\p{Cc}\p{Cf}]/u.test(value.key)) throw new Error('native-entry-failed');
  return value;
}

export async function nativeFolderEntry(helper, directory, signal, existing) {
  const value = await nativeEntry(helper, directory, signal, [existing ? '--folder-existing' : '--folder-parent']);
  if (typeof value.path !== 'string' || !value.path.startsWith('/') || value.path.length > 4096 || value.path.includes('\0')) throw new Error('native-entry-failed', { cause: { stage: 'folder-response', pathType: typeof value.path } });
  return value.path;
}

export async function nativeMCPEntry(helper, directory, endpoint, signal, qualify = false) {
  endpointURL(endpoint);
  const value = await nativeEntry(helper, directory, signal, ['--mcp', endpoint, ...(qualify ? ['--qualify', join(directory, 'mcp-secure-field.png')] : [])]);
  if (typeof value.key !== 'string' || !/^[A-Za-z0-9._~+\/-]{8,4096}={0,2}$/.test(value.key)) throw new Error('native-entry-failed');
  return value;
}
