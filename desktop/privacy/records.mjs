import { createHash } from 'node:crypto';
import { canonicalJSON, record } from '../core/settings.mjs';

export function createRecordCodec(vault, purpose) {
  try {
    if (!['workspace', 'development'].includes(purpose) || typeof vault?.sealPayload !== 'function' || typeof vault?.openPayload !== 'function') throw Error();
    const binding = { purpose, repository: null, id: 'record-protection-probe' }, bytes = vault.openPayload(binding, vault.sealPayload(binding, Buffer.alloc(0)));
    try { if (bytes.length) throw Error(); } finally { bytes.fill(0); }
  } catch { throw Error('protected-record-unavailable'); }
  function binding(identity) {
    record(identity, ['repository', 'table', 'key']);
    if (typeof identity.table !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(identity.table) || Buffer.byteLength(canonicalJSON(identity)) > 1024) throw Error();
    return { purpose, repository: identity.repository, id: 'record-' + createHash('sha256').update(canonicalJSON(identity)).digest('hex') };
  }
  return Object.freeze({
    encode(identity, value, metadata = {}) {
      let plain;
      try { plain = Buffer.from(canonicalJSON({ version: 1, metadata, value })); return vault.sealPayload(binding(identity), plain); }
      catch { throw Error('protected-record-unavailable'); } finally { plain?.fill(0); }
    },
    decode(identity, payload, metadata = {}) {
      let plain;
      try {
        if (!(payload instanceof Uint8Array)) throw Error();
        plain = vault.openPayload(binding(identity), Buffer.from(payload));
        const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)); record(envelope, ['version', 'metadata', 'value']);
        if (envelope.version !== 1 || canonicalJSON(envelope.metadata) !== canonicalJSON(metadata)) throw Error(); return envelope.value;
      } catch { throw Error('protected-record-invalid'); } finally { plain?.fill(0); }
    }
  });
}
