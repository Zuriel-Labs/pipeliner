'use strict';
const status = document.querySelector('#status');
const result = document.querySelector('#result');
let sequence = 0;
const operations = {
  ping: () => window.shellProbe.ping({ sequence: sequence++ % 10001 }),
  helper: () => window.shellProbe.helper({ mode: 'ping' }),
  dialog: () => window.shellProbe.dialog(),
  failure: () => window.shellProbe.helper({ mode: 'fail' }),
};
for (const [id, action] of Object.entries(operations)) {
  const button = document.getElementById(id);
  let running = false;
  button.addEventListener('click', async () => {
    if (running) return;
    running = true;
    const start = performance.now();
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-disabled', 'true');
    status.textContent = 'Running local check…';
    try {
      const reply = await action();
      result.textContent = JSON.stringify(reply, null, 2);
      status.textContent = `Local check complete (${(performance.now() - start).toFixed(1)} ms).`;
    } catch (error) {
      result.textContent = error.message;
      status.textContent = 'Local check failed. Check helper runs a fresh diagnostic.';
    } finally {
      running = false;
      button.removeAttribute('aria-busy');
      button.removeAttribute('aria-disabled');
    }
  });
}
