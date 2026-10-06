import { open, lstat, realpath, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { get } from 'node:https';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) throw Error('macos-restore-controller-required');

// Qualification only; the caller supplies the already leased empty role.
export const restore = Object.freeze({
  url: 'https://updates.cdn-apple.com/2026FallFCS/59241290-5d51-4ca8-9df4-31624b9a4eac/UniversalMac_27.0.1_26A434_Restore.ipsw',
  bytes: 26637307067, sha256: '2f016638293c3e641b8b25391a76fbc16563b3711915a5551cf8aa0f5598a5c1',
});

export async function writeLeasedRestore(path, response, expected, signal, progress = () => {}) {
  const named = await lstat(path), hash = createHash('sha256');
  if (await realpath(path) !== path || !named.isFile() || named.nlink !== 1 || named.uid !== process.getuid()
    || (named.mode & 0o777) !== 0o600 || named.size !== 0) throw Error('macos-restore-role-unverified');
  const file = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
  let written = 0, measured = 0, reported = 0;
  try {
    const opened = await file.stat();
    if (opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== 0 || opened.nlink !== 1
      || opened.uid !== named.uid || opened.mode !== named.mode) throw Error('macos-restore-role-unverified');
    for await (const value of response) {
      signal.throwIfAborted(); written += value.length;
      if (written > expected.bytes) throw Error('macos-restore-size-exceeded');
      hash.update(value);
      for (let offset = 0; offset < value.length;) {
        const result = await file.write(value,offset,value.length-offset);
        if (!result.bytesWritten) throw Error('macos-restore-write-unverified');
        offset += result.bytesWritten;
      }
      if (written - measured >= 32 * 1024 ** 2) {
        measured = written; const free = await statfs(path);
        if (free.bavail * free.bsize < 200 * 1024 ** 3) throw Error('macos-restore-storage-reserve-exhausted');
      }
      if (performance.now() - reported >= 10000) { reported = performance.now(); progress({ downloadedBytes: written, expectedBytes: expected.bytes }); }
    }
    signal.throwIfAborted();
    await file.sync();
    const after = await file.stat(), current = await lstat(path);
    if (written !== expected.bytes || after.size !== expected.bytes || current.size !== expected.bytes
      || after.dev !== named.dev || after.ino !== named.ino || current.dev !== named.dev || current.ino !== named.ino
      || after.nlink !== 1 || current.nlink !== 1 || after.uid !== named.uid || current.uid !== named.uid
      || after.mode !== named.mode || current.mode !== named.mode || hash.digest('hex') !== expected.sha256) throw Error('macos-restore-image-unverified');
    return { bytes: written, sha256: expected.sha256, inode: named.ino, device: named.dev };
  } finally { response.destroy(); await file.close(); }
}

export async function downloadLeasedRestore(path, signal, progress) {
  const timed = AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]);
  const response = await new Promise((done, reject) => {
    const request = get(restore.url, { agent: false, signal: timed, timeout: 30000, headers: { 'Accept-Encoding': 'identity' } }, done);
    request.once('error', reject); request.once('timeout', () => request.destroy(Error('macos-restore-network-timeout')));
  });
  if (response.statusCode !== 200 || response.headers['content-length'] !== String(restore.bytes)
    || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
    response.destroy(); throw Error('macos-restore-response-unverified');
  }
  try { return await writeLeasedRestore(path, response, restore, timed, progress); }
  finally { response.destroy(); }
}
