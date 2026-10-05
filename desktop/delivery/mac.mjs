import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';

const environment = { PATH: '/usr/bin:/bin', LC_ALL: 'C', HOME: process.env.HOME };
function command(file, args, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => execFile(file, args, { env: environment, signal, timeout: 5000, maxBuffer: 32768 },
    (error, stdout) => error ? reject(Error('Mac prerequisite check unavailable')) : resolve(stdout)));
}
export function signingPrerequisites(text) {
  const lines = text.trim().split('\n'), summary = /^\s*(\d+) valid identities found\s*$/.exec(lines.at(-1));
  const rows = lines.slice(0, -1).map(line => /^\s*\d+\) [a-fA-F0-9]{40} "([^"\r\n]+)"\s*$/.exec(line));
  if (!summary || Number(summary[1]) !== rows.length || rows.length > 64 || rows.some(row => !row)) throw Error('Signing inspection unavailable');
  return { developerId: rows.some(row => row[1].startsWith('Developer ID Application: ')) ? 'detected' : 'missing',
    localReview: rows.some(row => row[1].startsWith('Apple Development: ')) ? 'detected' : 'missing' };
}
// Fixed read-only probes. No repository-controlled path, argument, script or signing credential is accepted.
export async function inspectMacDelivery(signal) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Build host unqualified');
  const version = (await command('/usr/bin/sw_vers', ['-productVersion'], signal)).trim();
  if (!/^\d+(?:\.\d+){1,2}$/.test(version)) throw Error('Mac host inspection unavailable');
  const result = { host: 'macOS ' + version + ' · arm64', compiler: 'unavailable', compilerVersion: null, developerId: 'unavailable', localReview: 'unavailable' };
  const checks = await Promise.allSettled([
    (async () => {
      try {
        const compiler = (await command('/usr/bin/xcrun', ['--find', 'clang'], signal)).trim();
        if (!compiler.startsWith('/') || /[\x00-\x1f\x7f]/.test(compiler)) throw Error();
        const path = await realpath(compiler), before = await lstat(path);
        if (!before.isFile() || before.uid !== 0 || before.mode & 0o022) throw Error();
        await command('/usr/bin/codesign', ['--verify', '--strict', '-R', '=anchor apple', path], signal);
        const after = await lstat(path); if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error();
        const output = await command(path, ['--version'], signal), observed = /^Apple clang version (\d+(?:\.\d+){1,3})\b/m.exec(output);
        const current = await lstat(path); if (!observed || current.dev !== before.dev || current.ino !== before.ino || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) throw Error();
        result.compiler = 'detected'; result.compilerVersion = observed[1];
      } catch { signal.throwIfAborted(); }
    })(),
    (async () => { try { Object.assign(result, signingPrerequisites(await command('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], signal))); } catch { signal.throwIfAborted(); } })(),
  ]);
  signal.throwIfAborted(); if (checks.some(check => check.status === 'rejected')) throw Error('Mac prerequisite check unavailable'); return result;
}
