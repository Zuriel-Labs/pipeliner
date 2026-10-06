import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, symlinkSync, linkSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJSON } from '../core/settings.mjs';
import { buildIdentity, readBuildIdentity } from '../package/build.mjs';
import { verifyMacUpdateBundle } from './mac.mjs';

test('Mac update trust binds signed build identity, pinned Developer ID and distribution checks without execution', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeliner-54-native-update-'))), bundle = join(root, 'Pipeliner.app');
  const identity = { kind: 'pipeliner-desktop-build', schemaVersion: 1, sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40),
    version: '0.2.0', platform: 'darwin', architecture: 'arm64' }, team = 'ABCDEF1234';
  const resources = join(bundle, 'Contents/Resources'), executable = join(bundle, 'Contents/MacOS/Pipeliner'), file = join(resources, 'pipeliner-build.json');
  mkdirSync(resources, { recursive: true, mode: 0o700 }); mkdirSync(join(bundle, 'Contents/MacOS'), { mode: 0o700 });
  writeFileSync(executable, 'Synthetic non-executable fixture\n', { mode: 0o700 });
  writeFileSync(join(bundle, 'Contents/Info.plist'), 'Synthetic native plist fixture\n', { mode: 0o600 });
  const original = canonicalJSON(identity) + '\n', save = text => { writeFileSync(file, text, { mode: 0o600 }); chmodSync(file, 0o600); };
  let calls, mode, controller;
  const run = async (command, args, signal) => {
    signal.throwIfAborted(); calls.push({ command, args });
    assert(['/usr/bin/codesign', '/usr/bin/plutil', '/usr/bin/lipo', '/usr/bin/syspolicy_check'].includes(command));
    if (mode === 'cancel') { controller.abort(); signal.throwIfAborted(); }
    if (command === '/usr/bin/codesign' && args.includes('--verify')) {
      assert(args.includes('--deep')); assert(args.includes('--strict'));
      const requirement = args[args.indexOf('-R') + 1];
      assert(requirement.includes('anchor apple generic')); assert(requirement.includes('identifier "com.zuriellabs.pipeliner.desktop"'));
      assert(requirement.includes('certificate 1[field.1.2.840.113635.100.6.2.6] exists'));
      assert(requirement.includes('certificate leaf[field.1.2.840.113635.100.6.1.13] exists'));
      assert(requirement.includes('certificate leaf[subject.OU] = "' + team + '"'));
      for (const key of ['get-task-allow', 'cs.disable-library-validation', 'cs.allow-unsigned-executable-memory', 'cs.allow-dyld-environment-variables'])
        assert(requirement.includes('not (entitlement["com.apple.security.' + key + '"] = true)'));
      if (mode === 'signature' || mode === 'development') throw Error('Synthetic native refusal');
    }
    if (command === '/usr/bin/codesign' && args.includes('--display')) return { stdout: '', stderr:
      'TeamIdentifier=' + (mode === 'team' ? 'OTHER12345' : team) + '\nCodeDirectory v=20500 size=10 flags=' +
      (mode === 'runtime' ? '0x0(none)' : '0x10000(runtime)') + '\n' + (mode === 'timestamp' ? 'Signed Time=synthetic\n' : 'Timestamp=synthetic secure timestamp\n') };
    if (command === '/usr/bin/lipo') { assert.deepEqual(args, ['-archs', executable]); return { stdout: mode === 'architecture' ? 'x86_64\n' : 'arm64\n', stderr: '' }; }
    if (command === '/usr/bin/plutil') {
      assert.deepEqual(args, ['-convert', 'json', '-o', '-', join(bundle, 'Contents/Info.plist')]);
      return { stdout: JSON.stringify({ CFBundleIdentifier: 'com.zuriellabs.pipeliner.desktop', CFBundleExecutable: 'Pipeliner',
        CFBundlePackageType: 'APPL', CFBundleShortVersionString: identity.version, CFBundleVersion: identity.version }), stderr: '' };
    }
    if (command === '/usr/bin/syspolicy_check') {
      assert.deepEqual(args, ['distribution', bundle]);
      if (mode === 'policy') throw Error('Synthetic distribution refusal');
      if (mode === 'tamper') save(canonicalJSON({ ...identity, gitTree: 'c'.repeat(40) }) + '\n');
      if (mode === 'replace') { unlinkSync(file); save(original); }
    }
    return { stdout: '', stderr: '' };
  };
  const invoke = async selected => { calls = []; mode = selected; controller = new AbortController();
    return verifyMacUpdateBundle({ bundle, team, identity, signal: controller.signal }, { run }); };
  try {
    save(original); assert.deepEqual(buildIdentity(identity), identity); assert(Object.isFrozen(buildIdentity(identity)));
    assert.deepEqual(await readBuildIdentity(bundle), identity);
    const result = await invoke('valid'); assert.deepEqual(result.identity, identity); assert.equal(result.team, team); assert(Object.isFrozen(result));
    assert.equal(calls.filter(call => call.command === '/usr/bin/codesign' && call.args.includes('--verify')).length, 2);
    for (const selected of ['signature', 'development', 'team', 'runtime', 'timestamp', 'architecture', 'policy', 'cancel', 'tamper', 'replace']) {
      save(original); await assert.rejects(invoke(selected), /^Error: update-native-trust-unverified$/); assert(existsSync(file));
    }
    for (const text of ['\ufeff' + original, JSON.stringify(identity) + '\n', original.slice(0, -1), original + ' ',
      canonicalJSON({ ...identity, schemaVersion: 2 }) + '\n', canonicalJSON({ ...identity, architecture: 'x64' }) + '\n',
      canonicalJSON({ ...identity, gitTree: 'invalid' }) + '\n', canonicalJSON({ ...identity, extra: true }) + '\n']) {
      save(text); await assert.rejects(readBuildIdentity(bundle)); assert.equal(readFileSync(file, 'utf8'), text);
    }
    save(original); const other = join(root, 'linked.json'); linkSync(file, other); await assert.rejects(readBuildIdentity(bundle)); unlinkSync(other);
    unlinkSync(file); writeFileSync(other, original, { mode: 0o600 }); symlinkSync(other, file); await assert.rejects(readBuildIdentity(bundle)); unlinkSync(file); unlinkSync(other);
    save(original); chmodSync(file, 0o666); await assert.rejects(readBuildIdentity(bundle)); chmodSync(file, 0o600);
    mode = 'valid'; controller = new AbortController();
    for (const changed of [{ ...identity, sourceCommit: 'c'.repeat(40) }, { ...identity, version: '0.3.0' }]) {
      await assert.rejects(verifyMacUpdateBundle({ bundle, team, identity: changed }, { run }), /^Error: update-native-trust-unverified$/);
    }
    calls = []; await assert.rejects(verifyMacUpdateBundle({ bundle, team: 'bad" requirement', identity }, { run })); assert.equal(calls.length, 0);
  } finally { rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
});
