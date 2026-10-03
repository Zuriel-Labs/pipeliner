import { mkdtemp, realpath, chmod, writeFile, open, statfs, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { get } from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Qualification resource only: immutable Apple media, never credentials or a runtime update source.
if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.argv.length !== 2) throw new Error('macos-restore-host-unqualified');
const url = 'https://updates.cdn-apple.com/2026FallFCS/59241290-5d51-4ca8-9df4-31624b9a4eac/UniversalMac_27.0.1_26A434_Restore.ipsw';
const bytes = 26637307067, sha256 = '2f016638293c3e641b8b25391a76fbc16563b3711915a5551cf8aa0f5598a5c1';
const root = await realpath(await mkdtemp(join(tmpdir(), 'pipeliner-54-macos-worker-'))); await chmod(root, 0o700);
const path = join(root, 'Restore.ipsw'), began = performance.now(), hash = createHash('sha256');
const free = async () => { const value = await statfs(root); return value.bavail * value.bsize; };
let written = 0, measured = 0, progress = 0, file;
try {
  if (await free() < 64 * 1024 ** 3) throw new Error('macos-restore-storage-reserve-insufficient');
  await writeFile(join(root, 'ownership.json'), JSON.stringify({ issue: 54, owner: 'brimdor', root, resources: ['Restore.ipsw', 'VM disk', 'native helper'],
    cleanupTrigger: 'D-22 qualification completion or failure; preserve unrelated resources', bytes, sha256 }), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ root, owner: 'brimdor', issue: 54, expectedBytes: bytes, sha256 }));
  const response = await new Promise((done, reject) => {
    const request = get(url, { agent: false, timeout: 30000, headers: { 'Accept-Encoding': 'identity' } }, done);
    request.once('error', reject); request.once('timeout', () => request.destroy(new Error('macos-restore-network-timeout')));
  });
  if (response.statusCode !== 200 || Number(response.headers['content-length']) !== bytes) { response.destroy(); throw new Error('macos-restore-response-unverified'); }
  const limit = new Transform({ transform(value, encoding, done) {
    written += value.length;
    if (written > bytes) return done(new Error('macos-restore-size-exceeded'));
    hash.update(value);
    (async () => {
      if (written - measured >= 32 * 1024 ** 2) { measured = written; if (await free() < 16 * 1024 ** 3) throw new Error('macos-restore-storage-reserve-exhausted'); }
      if (performance.now() - progress >= 10000) { progress = performance.now(); console.log(JSON.stringify({ downloadedBytes: written, expectedBytes: bytes })); }
    })().then(() => done(null, value), done);
  } });
  await pipeline(response, limit, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.timeout(30 * 60 * 1000) });
  file = await open(path, 'r');
  await file.sync(); await file.close(); file = null;
  if (written !== bytes || (await stat(path)).size !== bytes || hash.digest('hex') !== sha256) throw new Error('macos-restore-image-unverified');
  console.log(JSON.stringify({ root, imageVerified: true, bytes, sha256, milliseconds: Math.round(performance.now() - began),
    retained: 'Goal-owned image for the next VM install; remove after installation' }));
} catch (error) {
  await file?.close(); await rm(root, { recursive: true });
  console.log(JSON.stringify({ failed: /^macos-restore-[a-z-]+$/.test(error.message) ? error.message : 'macos-restore-transfer-failed', exactOwnedRootRemoved: true }));
  process.exitCode = 1;
}
