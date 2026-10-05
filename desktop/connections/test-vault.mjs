import { openVault } from './vault.mjs';

// Development/test fixtures only. Actual vault encryption, synthetic OS wrapping.
// This module is excluded from the packaged runtime and must never wrap user credentials.
export const syntheticWrapping = Object.freeze({
  available: async () => true,
  encrypt: async text => Buffer.from(text.split('').reverse().join('')),
  decrypt: async bytes => ({ result: bytes.toString().split('').reverse().join(''), shouldReEncrypt: false }),
});
export const openTestVault = directory => openVault(directory, syntheticWrapping);
