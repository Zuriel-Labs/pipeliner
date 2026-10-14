import test from 'node:test';
import assert from 'node:assert/strict';
import { taskHTML } from './task-output.mjs';

const html = '<!DOCTYPE html><html lang="en"><head><title>Synthetic queue</title></head><body><button>Ready</button></body></html>';
test('a single HTML document remains data with or without one clearly fenced output block', () => {
  assert.equal(taskHTML(html), html);
  assert.equal(taskHTML('Explanation is not configuration.\n```html\n' + html + '\n```\nReview separately.'), html);
});
test('ambiguous, oversized, incomplete or forbidden output never reaches the renderer', () => {
  for (const value of [null, 'Narrative only', '<html></html>', html + '\nMore text', '```js\n' + html + '\n```',
    '```html\n' + html + '\n```\n```html\n' + html + '\n```', html.replace('</body>', '<iframe></iframe></body>'),
    html.replace('</body>', '<script src="https://example.invalid/a.js"></script></body>'),
    html.replace('</body>', '<script>eval("unsafe")</script></body>'), html.replace('</body>', 'x'.repeat(131072) + '</body>')]) {
    assert.throws(() => taskHTML(value), /task-html-denied/);
  }
});
