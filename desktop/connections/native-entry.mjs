import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function nativeKeyEntry(helper, directory, signal, qualify = false) {
  const file = lstatSync(helper);
  if (file.isSymbolicLink() || !file.isFile() || file.uid !== process.getuid() || (file.mode & 0o022) || realpathSync(helper) !== resolve(helper)) throw new Error('native-entry-failed');
  signal?.throwIfAborted();
  return new Promise((resolveEntry, reject) => {
    const child = spawn(helper, qualify ? ['--qualify', join(directory, 'secure-field.png')] : [], { env: { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', oversized = false, launchFailed = false;
    child.stderr.on('data', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { if (Buffer.byteLength(output) + Buffer.byteLength(data) > 4096) { oversized = true; child.kill('SIGTERM'); } else output += data; });
    const abort = () => child.kill('SIGTERM'); signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => { launchFailed = true; });
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted || code === 143) { reject(new Error('native-entry-cancelled')); return; }
      if (code !== 0 || oversized || launchFailed) { reject(new Error('native-entry-failed')); return; }
      try {
        const value = JSON.parse(output); output = '';
        if (value.cancelled) { reject(new Error('native-entry-cancelled')); return; }
        if (typeof value.key !== 'string' || value.key.length < 8 || value.key.length > 512 || /\s|[\p{Cc}\p{Cf}]/u.test(value.key)) throw new Error();
        resolveEntry(value);
      } catch { reject(new Error('native-entry-failed')); }
    });
  });
}
