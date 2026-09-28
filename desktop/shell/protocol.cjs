'use strict';
const APP_URL = 'pipeliner-probe://shell/index.html';
const ASSETS = ['index.html', 'renderer.js', 'style.css'];

function assetName(url) {
  return ASSETS.find(name => url === `pipeliner-probe://shell/${name}`) ?? null;
}

function validateRequest(operation, payload, sender) {
  if (sender.id !== sender.expectedId || !sender.mainFrame || sender.url !== APP_URL) {
    throw new Error('Untrusted shell sender');
  }
  const exactObject = key => payload !== null && typeof payload === 'object'
    && !Array.isArray(payload) && Object.keys(payload).length === 1
    && Object.hasOwn(payload, key);
  if (operation === 'ping' && exactObject('sequence') && Number.isSafeInteger(payload.sequence)
      && payload.sequence >= 0 && payload.sequence <= 10000) return payload;
  if (operation === 'helper' && exactObject('mode') && ['ping', 'fail'].includes(payload.mode)) return payload;
  if (['dialog', 'status'].includes(operation) && payload === null) return null;
  throw new Error('Invalid shell request');
}
module.exports = { APP_URL, ASSETS, assetName, validateRequest };
