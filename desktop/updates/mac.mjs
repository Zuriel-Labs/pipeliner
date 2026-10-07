import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJSON, immutable, record } from '../core/settings.mjs';
import { backgroundBundleId } from '../background/native.mjs';
import { buildIdentity, buildIdentityName, readBuildIdentity } from '../package/build.mjs';

export function runMacUpdateCommand(file, args, signal, input) {
  signal.throwIfAborted();
  if (input !== undefined && (typeof input !== 'string' || Buffer.byteLength(input) > 32768)) throw Error('update-native-trust-unverified');
  const env = { PATH: '/usr/bin:/bin', LC_ALL: 'C', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) };
  return new Promise((resolve, reject) => {
    let inputFailed = false, closed = false, output;
    function finish() {
      if (!closed || !output) return;
      const { error, stdout, stderr } = output;
      if (!error && !inputFailed && !signal.aborted) { resolve({ stdout, stderr }); return; }
      const failure = Error('update-native-trust-unverified');
      if (!inputFailed && !signal.aborted && Number.isInteger(error?.code) && error.code > 0 && error.code <= 255
        && error.killed === false && error.signal === null && child.killed === false && child.signalCode === null
        && child.exitCode === error.code) Object.defineProperty(failure, 'nativeExitCode', { value: error.code });
      reject(failure);
    }
    const child = execFile(file, args, { env, signal, killSignal: 'SIGKILL', timeout: 15000, maxBuffer: 32768 },
      (error, stdout, stderr) => { output = { error, stdout, stderr }; finish(); });
    child.once('close', () => { closed = true; finish(); });
    child.stdin.on('error', () => { inputFailed = true; child.kill('SIGKILL'); }); child.stdin.end(input);
  });
}
const stable = (a, b) => ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
export function macUpdateRequirement(team) {
  if (typeof team !== 'string' || !/^[A-Z0-9]{10}$/.test(team)) throw Error('update-native-trust-unverified');
  return '=anchor apple generic and identifier "' + backgroundBundleId + '" and certificate 1[field.1.2.840.113635.100.6.2.6] exists' +
    ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "' + team + '"' +
    ['get-task-allow', 'cs.disable-library-validation', 'cs.allow-unsigned-executable-memory', 'cs.allow-dyld-environment-variables']
      .map(key => ' and !(entitlement["com.apple.security.' + key + '"] exists)').join('');
}

// Host-only trust check. Its caller must obtain identity from authenticated history and reverify before installation.
export async function verifyMacUpdateBundle(options, { run = runMacUpdateCommand } = {}) {
  try {
    record(options, ['bundle', 'team', 'identity'], ['signal']); const { bundle, team } = options, identity = buildIdentity(options.identity);
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || typeof run !== 'function'
      || typeof bundle !== 'string' || resolve(bundle) !== bundle || !bundle.endsWith('.app') || /[\x00-\x1f\x7f]/.test(bundle)
      || typeof team !== 'string' || !/^[A-Z0-9]{10}$/.test(team) || options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw Error();
    const signal = options.signal ?? new AbortController().signal, requirement = macUpdateRequirement(team);
    const executable = join(bundle, 'Contents/MacOS/Pipeliner'), plist = join(bundle, 'Contents/Info.plist'), resource = join(bundle, 'Contents/Resources', buildIdentityName);
    const paths = [bundle, plist, resource, executable], original = [];
    async function inspect() {
      for (let index = 0; index < paths.length; index++) {
        const value = await lstat(paths[index]);
        if (await realpath(paths[index]) !== paths[index] || value.isSymbolicLink() || ![0, process.getuid()].includes(value.uid) || value.mode & 0o022
          || (index === 0 ? !value.isDirectory() : !value.isFile() || value.nlink !== 1) || index === 3 && !(value.mode & 0o111)) throw Error();
        if (original.length > index) { if (!stable(original[index], value)) throw Error(); } else original.push(value);
      }
      signal.throwIfAborted();
    }
    await inspect(); if (canonicalJSON(await readBuildIdentity(bundle, { signal })) !== canonicalJSON(identity)) throw Error();
    const verify = () => run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', requirement, bundle], signal);
    await verify();
    const details = (await run('/usr/bin/codesign', ['--display', '--verbose=4', bundle], signal)).stderr;
    const field = name => { const values = [...details.matchAll(new RegExp('^' + name + '=([^\\r\\n]+)$', 'gm'))]; if (values.length !== 1) throw Error(); return values[0][1]; };
    const flags = /^CodeDirectory .* flags=0x([a-fA-F0-9]+)\([^\r\n)]*\)/m.exec(details)?.[1];
    if (field('TeamIdentifier') !== team || !field('Timestamp') || !flags || !(parseInt(flags, 16) & 0x10000)) throw Error();
    const info = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], signal)).stdout);
    if (info.CFBundleIdentifier !== backgroundBundleId || info.CFBundleExecutable !== 'Pipeliner' || info.CFBundlePackageType !== 'APPL'
      || info.CFBundleShortVersionString !== identity.version || info.CFBundleVersion !== identity.version) throw Error();
    const architectures = (await run('/usr/bin/lipo', ['-archs', executable], signal)).stdout.trim().split(/\s+/);
    if (!architectures.includes('arm64') || architectures.length > 2 || new Set(architectures).size !== architectures.length
      || architectures.some(value => !['arm64', 'x86_64'].includes(value))) throw Error();
    await run('/usr/bin/syspolicy_check', ['distribution', bundle], signal);
    await verify(); await inspect(); if (canonicalJSON(await readBuildIdentity(bundle, { signal })) !== canonicalJSON(identity)) throw Error();
    await inspect(); return immutable({ identity, team });
  } catch { throw Error('update-native-trust-unverified'); }
}
