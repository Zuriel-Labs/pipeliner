import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateRequest, assetName, APP_URL } = require('../desktop/shell/protocol.cjs');
const sender = { id: 7, expectedId: 7, mainFrame: true, url: APP_URL };

test('shell IPC accepts only bounded diagnostic operations and exact payloads', () => {
  assert.deepEqual(validateRequest('ping', { sequence: 42 }, sender), { sequence: 42 });
  assert.deepEqual(validateRequest('helper', { mode: 'fail' }, sender), { mode: 'fail' });
  assert.equal(validateRequest('dialog', null, sender), null);
  for (const [operation, payload] of [
    ['shell', { command: 'whoami' }], ['ping', null], ['ping', { sequence: -1 }],
    ['ping', { sequence: 1.2 }], ['ping', { sequence: '1' }],
    ['ping', { sequence: 1, path: '/tmp' }], ['helper', { mode: 'exec' }],
    ['helper', { mode: 'ping', extra: true }], ['dialog', {}], ['ping', { sequence: 10001 }],
  ]) assert.throws(() => validateRequest(operation, payload, sender));
});

test('shell IPC rejects foreign contents, subframes, origins and navigation', () => {
  for (const invalid of [
    { id: 8 }, { mainFrame: false }, { url: 'https://example.com/' },
    { url: APP_URL + '?forged=1' }, { url: 'pipeliner-probe://shell/other.html' },
  ]) assert.throws(() => validateRequest('ping', { sequence: 1 }, { ...sender, ...invalid }));
});

test('asset resolution accepts the fixed app files only, without traversal or URL variants', () => {
  assert.equal(assetName(APP_URL), 'index.html');
  assert.equal(assetName('pipeliner-probe://shell/renderer.js'), 'renderer.js');
  for (const url of [
    'file:///etc/passwd', 'pipeliner-probe://foreign/index.html',
    'pipeliner-probe://shell/%2e%2e/package.json', 'pipeliner-probe://shell/index.html?x=1',
    'pipeliner-probe://shell/index.html#x', 'pipeliner-probe://shell/%69ndex.html',
    'pipeliner-probe://user@shell/index.html', 'pipeliner-probe://shell:7/index.html',
    'pipeliner-probe://shell/roadmap.html', 'pipeliner-probe://shell/protocol.cjs',
  ]) assert.equal(assetName(url), null);
});
