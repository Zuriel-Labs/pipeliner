import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, lstat, realpath, writeFile, readFile, chmod, readdir, rm } from 'node:fs/promises';
import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';
import { canonicalJSON } from '../desktop/core/settings.mjs';
import { buildIdentityName } from '../desktop/package/build.mjs';
import { openVault } from '../desktop/connections/vault.mjs';
import { openUpdateHistory } from '../desktop/updates/history.mjs';
import { withMacUpdateImage } from '../desktop/updates/image.mjs';
import { runMacUpdateCommand } from '../desktop/updates/mac.mjs';

// Synthetic native qualification only; never execute, install or sign the fixture.
if (process.argv.length !== 2 || process.env.NODE_OPTIONS || process.platform !== 'darwin' || process.arch !== 'arm64')
  throw Error('update-image-probe-startup-denied');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { validateContext, validateOwnedDataDirectory } = createRequire(import.meta.url)('../desktop/test-storage.cjs');
const storage = validateContext(repository);
if (storage.run_path !== join('/Volumes/TESTING/TestArtifacts/projects/pipeliner/issues/54/runs', storage.run_path.split('/').at(-1))
  || process.env.TMPDIR !== storage.paths.tmp) throw Error('update-image-probe-run-denied');

const root = join(storage.paths.tmp, 'update-image-native'), directory = join(root, 'updates'), source = join(root, 'source');
const file = join(directory, 'update-' + randomUUID() + '.dmg');
const started = performance.now(), controller = new AbortController(), clock = () => 1000;
const abort = () => controller.abort(), timer = setTimeout(abort, 120000);
process.once('SIGTERM', abort); process.once('SIGINT', abort);
const counts = { created: 0, attached: 0, readonly: 0, signatureRefused: 0, detached: 0, consumed: 0 };
let owner, vault, history, clean = false, result, failure;
const same = (a, b) => ['dev', 'ino', 'uid', 'mode'].every(key => a[key] === b[key]);
async function native(command, args, signal, input) {
  let output;
  try { output = await runMacUpdateCommand(command, args, signal, input); }
  catch (error) { if (command === '/usr/bin/codesign' && args.includes('--verify')) counts.signatureRefused++; throw error; }
  if (command === '/usr/bin/hdiutil' && args[0] === 'create') counts.created++;
  if (command === '/usr/bin/hdiutil' && args[0] === 'attach') counts.attached++;
  if (command === '/usr/bin/hdiutil' && args[0] === 'detach') counts.detached++;
  if (command === '/usr/sbin/diskutil') {
    const converted = await runMacUpdateCommand('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], signal, output.stdout);
    const value = JSON.parse(converted.stdout);
    if (value.ReadOnlyMedia === true && value.ReadOnlyVolume === true) counts.readonly++;
  }
  return output;
}
async function imagesAbsent() {
  const signal = new AbortController().signal;
  const observed = await runMacUpdateCommand('/usr/bin/hdiutil', ['info', '-plist'], signal);
  const converted = await runMacUpdateCommand('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], signal, observed.stdout);
  const images = JSON.parse(converted.stdout).images;
  assert(Array.isArray(images) && images.length <= 64);
  assert(!images.some(image => image?.['image-path'] === file || image?.['system-entities']?.some(entity =>
    typeof entity?.['mount-point'] === 'string' && entity['mount-point'].startsWith(root + '/'))));
}
async function inspectOwned(path) {
  const info = await lstat(path);
  assert.equal(await realpath(path), path); assert.equal(info.uid, process.getuid()); assert.equal(info.dev, owner.dev);
  assert(!info.isSymbolicLink() && !(info.mode & 0o077));
  if (info.isDirectory()) for (const name of await readdir(path)) await inspectOwned(join(path, name));
  else assert(info.isFile() && info.nlink === 1);
}
try {
  await mkdir(root, { mode: 0o700 }); owner = await lstat(root); validateOwnedDataDirectory(storage, root);
  await mkdir(directory, { mode: 0o700 }); await mkdir(source, { mode: 0o700 });
  const bundle = join(source, 'Pipeliner.app');
  for (const path of [bundle, join(bundle, 'Contents'), join(bundle, 'Contents/MacOS'), join(bundle, 'Contents/Resources')])
    await mkdir(path, { mode: 0o700 });
  const current = { channel: 'stable', platform: 'darwin', architecture: 'arm64', version: '0.1.0' };
  const identity = { kind: 'pipeliner-desktop-build', schemaVersion: 1, platform: 'darwin', architecture: 'arm64',
    version: '0.2.0', sourceCommit: 'b'.repeat(40), gitTree: 'c'.repeat(40) };
  await writeFile(join(bundle, 'Contents/MacOS/Pipeliner'), 'Synthetic unsigned fixture. Never execute this file.\n', { flag: 'wx', mode: 0o700 });
  await writeFile(join(bundle, 'Contents/Resources', buildIdentityName), canonicalJSON(identity) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(bundle, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict>' +
    '<key>CFBundleIdentifier</key><string>com.zuriellabs.pipeliner.desktop</string><key>CFBundleExecutable</key><string>Pipeliner</string>' +
    '<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>0.2.0</string>' +
    '<key>CFBundleShortVersionString</key><string>0.2.0</string></dict></plist>\n', { flag: 'wx', mode: 0o600 });
  await native('/usr/bin/hdiutil', ['create', '-srcfolder', source, '-format', 'UDZO', '-fs', 'HFS+', '-layout', 'GPTSPUD',
    '-size', '16m', '-volname', 'PipelinerSynthetic54', '-uid', String(process.getuid()), '-gid', String(process.getgid()), '-mode', '0700', file], controller.signal);
  const image = await lstat(file);
  assert(image.isFile() && !image.isSymbolicLink() && image.nlink === 1 && image.uid === process.getuid()
    && image.dev === owner.dev && image.size > 0 && image.size <= 32 * 1024 ** 2 && await realpath(file) === file);
  await chmod(file, 0o600); const bytes = await readFile(file), sha256 = createHash('sha256').update(bytes).digest('hex');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const trust = { id: 'synthetic-publisher', key: publicKey, origin: 'https://updates.example.com', path: '/desktop/releases/' };
  const release = { kind: 'pipeliner-desktop-update', schemaVersion: 1, source: trust.id, ...current, version: identity.version,
    sourceCommit: identity.sourceCommit, gitTree: identity.gitTree, sequence: 1, issuedAt: 900, expiresAt: 2000,
    url: trust.origin + trust.path + 'Pipeliner.dmg', bytes: bytes.length, sha256 };
  vault = await openVault(root, { available: async () => true, encrypt: async text => Buffer.from(text),
    decrypt: async data => ({ result: data.toString(), shouldReEncrypt: false }) });
  history = openUpdateHistory(root, { vault, clock }); const attempt = history.begin(trust, current);
  history.complete(attempt.token, Buffer.from(canonicalJSON({ release,
    signature: sign(null, Buffer.from(canonicalJSON(release)), privateKey).toString('base64') })));
  const saved = history.read(trust, current); history.close(); history = undefined;
  const protectedHistory = { read(...args) {
    const handle = openUpdateHistory(root, { vault, clock }); try { return handle.read(...args); } finally { handle.close(); }
  } };
  await assert.rejects(withMacUpdateImage({ directory, file, history: protectedHistory, trust, current,
    team: 'ABCDEF1234', signal: controller.signal, isCurrent: () => !controller.signal.aborted }, async () => {
    counts.consumed++; throw Error('update-image-probe-consumption-denied');
  }, { run: native, clock }), /^Error: update-image-unverified$/);
  assert.equal(counts.created, 1); assert.equal(counts.attached, 1); assert.equal(counts.detached, 1);
  assert.equal(counts.signatureRefused, 1); assert(counts.readonly >= 1); assert.equal(counts.consumed, 0);
  assert.equal(canonicalJSON(protectedHistory.read(trust, current)), canonicalJSON(saved));
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), sha256);
  assert.deepEqual(await readdir(directory), [file.split('/').at(-1)]); await imagesAbsent();
  clean = true; result = { kind: 'pipeliner-native-update-image-refusal', schemaVersion: 1, counts,
    imageBytes: bytes.length, imageSha256: sha256, elapsedMs: Math.round(performance.now() - started),
    syntheticPublisher: true, syntheticOSWrapping: true, fixtureExecutableNeverRun: true,
    developerIdAcceptance: 'not-run', internalNativeScratch: 'unverified' };
} catch { failure = true; }
finally {
  clearTimeout(timer); process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort);
  history?.close(); vault?.close();
  if (clean) try {
    validateOwnedDataDirectory(storage, root); assert(same(owner, await lstat(root))); await inspectOwned(root); await imagesAbsent();
    await rm(root, { recursive: true });
    await assert.rejects(lstat(root), error => error.code === 'ENOENT'); result.fixtureRemoved = true;
  } catch { failure = true; }
}
if (failure) { console.error('update-image-probe-failed; preserve fixture and launcher evidence'); process.exitCode = 1; }
else console.log(JSON.stringify(result));
