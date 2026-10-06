import { KeyObject, verify } from 'node:crypto';
import { canonicalJSON, immutable, record } from '../core/settings.mjs';

function version(value) {
  if (typeof value !== 'string' || value.length > 96) throw Error();
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) throw Error();
  const pre = match[4]?.split('.') ?? [];
  if (pre.some(id => /^\d+$/.test(id) && id.length > 1 && id.startsWith('0'))) throw Error();
  return { core: match.slice(1, 4).map(BigInt), pre };
}
function newer(candidate, installed) {
  const a = version(candidate), b = version(installed);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  if (!a.pre.length || !b.pre.length) return !a.pre.length && Boolean(b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined || b.pre[i] === undefined) return b.pre[i] === undefined;
    if (a.pre[i] === b.pre[i]) continue;
    const an = /^\d+$/.test(a.pre[i]), bn = /^\d+$/.test(b.pre[i]);
    return an && bn ? BigInt(a.pre[i]) > BigInt(b.pre[i]) : an !== bn ? bn : a.pre[i] > b.pre[i];
  }
  return false;
}

export function checkUpdateContext(trust, current, now) {
  try {
    record(trust, ['id', 'key', 'origin', 'path']); record(current, ['channel', 'platform', 'architecture', 'version', 'sequence']);
    if (!(trust.key instanceof KeyObject) || trust.key.type !== 'public' || trust.key.asymmetricKeyType !== 'ed25519'
      || typeof trust.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(trust.id) || !Number.isSafeInteger(now) || now < 0
      || !Number.isSafeInteger(current.sequence) || current.sequence < 0 || current.platform !== 'darwin' || current.architecture !== 'arm64'
      || !['stable', 'beta', 'alpha'].includes(current.channel) || typeof trust.origin !== 'string' || trust.origin.length > 2048) throw Error();
    version(current.version);
    const origin = new URL(trust.origin);
    if (origin.protocol !== 'https:' || origin.origin !== trust.origin || origin.username || origin.password || origin.search || origin.hash
      || typeof trust.path !== 'string' || trust.path.length > 1024 || !/^\/(?:[A-Za-z0-9_-]+\/)+$/.test(trust.path)) throw Error();
    return origin;
  } catch { throw Error('update-metadata-unverified'); }
}

// Host-only trust and retained sequence are independent of the received envelope.
// This verifies metadata; native binary trust, backup and idle installation are separate gates.
export function verifyUpdateAvailability(bytes, { trust, current, now }) {
  try {
    const origin = checkUpdateContext(trust, current, now);
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 16384) throw Error();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), envelope = JSON.parse(text);
    canonicalJSON(envelope); record(envelope, ['release', 'signature']);
    if (text !== canonicalJSON(envelope) || typeof envelope.signature !== 'string' || envelope.signature.length !== 88) throw Error();
    const signature = Buffer.from(envelope.signature, 'base64'), release = envelope.release;
    if (signature.length !== 64 || signature.toString('base64') !== envelope.signature || !verify(null, Buffer.from(canonicalJSON(release)), trust.key, signature)) throw Error();
    record(release, ['kind', 'schemaVersion', 'source', 'channel', 'platform', 'architecture', 'version', 'sequence', 'issuedAt', 'expiresAt', 'url', 'bytes', 'sha256', 'sourceCommit', 'gitTree']);
    if (release.kind !== 'pipeliner-desktop-update' || release.schemaVersion !== 1 || release.source !== trust.id
      || ['channel', 'platform', 'architecture'].some(key => release[key] !== current[key]) || !Number.isSafeInteger(release.sequence) || release.sequence <= current.sequence
      || ![release.issuedAt, release.expiresAt].every(Number.isSafeInteger)
      || release.issuedAt < 0 || release.issuedAt > now || release.expiresAt <= now || release.expiresAt - release.issuedAt > 7 * 86400000
      || !Number.isSafeInteger(release.bytes) || release.bytes < 1 || release.bytes > 8 * 1024 ** 3
      || typeof release.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(release.sha256)
      || ![release.sourceCommit, release.gitTree].every(value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))) throw Error();
    const url = new URL(release.url);
    if (typeof release.url !== 'string' || release.url.length > 2048 || url.href !== release.url || url.protocol !== 'https:' || url.origin !== origin.origin
      || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(trust.path)
      || !/^[A-Za-z0-9_./-]+\.dmg$/.test(url.pathname) || url.pathname.split('/').some(part => part === '.' || part === '..')) throw Error();
    return immutable({ release, available: newer(release.version, current.version) });
  } catch { throw Error('update-metadata-unverified'); }
}

export function verifyUpdateManifest(bytes, context) {
  const result = verifyUpdateAvailability(bytes, context);
  if (!result.available) throw Error('update-metadata-unverified');
  return result.release;
}
