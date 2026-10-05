'use strict';
const assert = require('node:assert/strict');
const { writeFileSync, mkdirSync, readFileSync, existsSync } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { join } = require('node:path');

exports.run = async ({ window, directory, delivery, artifacts, appearance, channel, policy, js, wait, check, measurements }) => {
  const chat = text => js(`document.getElementById('chat-nav').click();document.getElementById('prompt').value=${JSON.stringify(text)};document.getElementById('composer').requestSubmit()`);
  const show = () => js("document.getElementById('settings-nav').click();document.getElementById('settings-delivery').click()");
  const change = async text => { await chat(text); await wait(() => Boolean(delivery.status().preview)); await chat('Apply this delivery change'); await wait(() => !delivery.status().preview); };
  await check('delivery-empty-installer-and-exact-registered-control', async () => {
    await chat('Where is the installer?'); await wait(() => js("!document.getElementById('delivery-settings').hidden"));
    assert.equal(delivery.status().installer, null); assert.equal(delivery.status().buildQualified, false);
    assert.equal(delivery.status().values['delivery.publish'].value, false);
    assert.equal(await js("document.getElementById('delivery-artifact').textContent.includes('No verified project installer')"), true);
    const frame = window.webContents.mainFrame, event = { sender: window.webContents, senderFrame: frame }, payload = { operation: 'prepare', scope: 'host', changes: { 'delivery.capacityGiB': 12 }, contextRevision: delivery.status().revision };
    assert.throws(() => channel.dispatch({ ...event, sender: {} }, payload));
    assert.throws(() => channel.dispatch({ ...event, senderFrame: { url: frame.url, parent: frame } }, payload));
    assert.throws(() => channel.dispatch(event, { ...payload, target: 'forged' }));
    assert.throws(() => channel.dispatch(event, { ...payload, contextRevision: 0 }));
    assert.equal(delivery.status().preview, null);
  });
  await check('delivery-chat-scopes-native-keyboard-apply-and-inheritance', async () => {
    const selected = delivery.status().repository.id;
    await chat('Keep the latest 5 artifacts for this repository'); await wait(() => Boolean(delivery.status().preview)); await show();
    assert.equal(delivery.status().preview.target, selected); assert.equal(policy.worker.read(selected).values['delivery.keepLatest'].value, 3);
    await js("document.getElementById('delivery-apply').focus()"); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await wait(() => policy.worker.read(selected).values['delivery.keepLatest'].value === 5);
    await change('Keep the latest 4 artifacts globally'); assert.equal(policy.worker.read(selected).values['delivery.keepLatest'].value, 5);
    await change('Reset repository delivery settings'); assert.equal(policy.worker.read(selected).values['delivery.keepLatest'].value, 4);
    assert.equal(policy.worker.read(selected).values['delivery.keepLatest'].source, 'global');
  });
  await check('delivery-form-drafts-host-scope-and-unchanged-save', async () => {
    await show(); await js("document.getElementById('delivery-scope-host').click()"); await wait(() => delivery.status().scope === 'host');
    await js("document.getElementById('delivery-capacityGiB').value='12';document.getElementById('delivery-capacityGiB').focus()"); delivery.sync();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await js("document.getElementById('delivery-capacityGiB').value"), '12'); assert.equal(await js('document.activeElement.id'), 'delivery-capacityGiB');
    await js("document.getElementById('prompt').value='Unsent delivery draft';document.getElementById('prompt').dispatchEvent(new Event('input'));document.getElementById('delivery-warningGiB').value='9';document.getElementById('delivery-form').requestSubmit()");
    await wait(() => Boolean(delivery.status().preview)); assert.equal(delivery.status().preview.scope, 'host');
    assert.deepEqual(Object.keys(delivery.status().preview.after).sort(), ['delivery.capacityGiB', 'delivery.warningGiB']);
    await js("document.getElementById('delivery-apply').click()"); await wait(() => policy.worker.read(null).values['delivery.capacityGiB'].value === 12);
    assert.equal(await js("document.getElementById('prompt').value"), 'Unsent delivery draft');
    const version = policy.worker.read(null).revision; await js("document.getElementById('delivery-form').requestSubmit()");
    await wait(() => delivery.status().message.includes('already match')); assert.equal(policy.worker.read(null).revision, version); assert.equal(delivery.status().preview, null);
  });
  await check('delivery-actual-Mac-prerequisite-detection-and-renderer-reload', async () => {
    const version = policy.worker.read(null).revision;
    await chat('Check this Mac for builds'); await wait(() => !delivery.status().busy && Boolean(delivery.status().prerequisites));
    const result = delivery.status().prerequisites;
    assert.match(result.host, /^macOS [0-9.]+ · arm64$/); assert.equal(Object.keys(result).length, 5);
    assert.equal(result.compiler, 'detected'); assert.match(result.compilerVersion, /^\d+(?:\.\d+){1,3}$/);
    measurements.push({ inspection: 'actual-read-only-Mac-delivery-prerequisites', ...result });
    assert.equal(policy.worker.read(null).revision, version); assert.equal(delivery.status().buildQualified, false);
    await new Promise((resolve, reject) => { window.webContents.once('did-finish-load', resolve); window.webContents.once('did-fail-load', reject); window.reload(); });
    await wait(() => js("Boolean(document.getElementById('delivery-form'))")); await show();
    assert.equal(await js("document.getElementById('delivery-capacityGiB').value"), '12'); assert.equal(policy.worker.read(null).revision, version);
  });
  await check('delivery-stale-cancel-labels-and-200-percent-native-reflow', async () => {
    await chat('Set artifact capacity to 13 GiB'); await wait(() => Boolean(delivery.status().preview)); const old = delivery.status();
    await delivery.dispatch({ operation: 'cancel' }); const frame = window.webContents.mainFrame;
    assert.throws(() => channel.dispatch({ sender: window.webContents, senderFrame: frame }, { operation: 'apply', hash: old.preview.hash, contextRevision: old.revision }));
    assert.equal(policy.worker.read(null).values['delivery.capacityGiB'].value, 12);
    appearance.dispatch({ operation: 'prepare', changes: { 'appearance.textScale': 2 } }); appearance.dispatch({ operation: 'apply' });
    await show(); window.setSize(420, 760); await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(await js("Array.from(document.querySelectorAll('#delivery-form input')).every(input=>Array.from(document.querySelectorAll('#delivery-form label')).some(label=>label.htmlFor===input.id))"), true);
    assert.equal(await js("Array.from(document.querySelectorAll('#delivery-settings button')).every(button=>button.getBoundingClientRect().height>=44)"), true);
    await js("(()=>{const input=document.getElementById('delivery-warningGiB');const offset=document.querySelector('.app-nav').getBoundingClientRect().bottom+40;window.scrollTo(0,window.scrollY+input.getBoundingClientRect().top-offset)})()");
    await wait(() => js("(()=>{const input=document.getElementById('delivery-warningGiB').getBoundingClientRect();return input.top>=document.querySelector('.app-nav').getBoundingClientRect().bottom && input.bottom<innerHeight})()"));
    await new Promise(resolve => setTimeout(resolve, 150));
    writeFileSync(join(directory, 'delivery-fields-capture.png'), (await window.webContents.capturePage()).toPNG(), { flag: 'wx', mode: 0o600 });
    window.setSize(1180, 840); appearance.dispatch({ operation: 'prepare', changes: { 'appearance.textScale': 1 } }); appearance.dispatch({ operation: 'apply' }); await show();
  });
  await check('delivery-native-protected-artifact-custody-chat-pin-recovery-and-safe-retention', async () => {
    await change('Keep the latest 1 artifacts for this repository');
    const source = join(directory, 'artifact-fixture'); mkdirSync(source, { mode: 0o700 });
    const repository = delivery.status().repository.id, receipts = [];
    for (const name of ['one', 'two', 'three', 'four', 'five']) {
      const bytes = Buffer.from(('private synthetic artifact ' + name + '\n').repeat(2400)), filename = name + '.dmg', sha256 = createHash('sha256').update(bytes).digest('hex');
      writeFileSync(join(source, filename), bytes, { flag: 'wx', mode: 0o600 });
      receipts.push(await artifacts.capture({ repository, commandId: randomUUID(), sourceDirectory: source, manifest: { name: filename, bytes: bytes.length, sha256,
        sourceCommit: 'a'.repeat(40), gitTree: 'b'.repeat(40), host: { os: 'darwin', architecture: 'arm64', version: '27.0.1' }, validation: { protocol: 'synthetic-custody-fixture', result: 'passed', receiptHash: sha256 } } }));
    }
    delivery.sync(); await chat('Show retained artifacts'); await wait(() => js("document.querySelectorAll('.artifact-record').length===5"));
    await js(`document.getElementById('artifact-pin-${receipts[0].id}').click()`); await wait(() => Boolean(delivery.status().artifactPreview));
    await js("document.getElementById('artifact-apply').focus()"); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await wait(() => artifacts.inventory(repository).items.find(item => item.id === receipts[0].id).pinned);
    await js(`document.getElementById('artifact-recovery-${receipts[1].id}').click()`); await wait(() => Boolean(delivery.status().artifactPreview));
    await chat('Apply this artifact change'); await wait(() => artifacts.inventory(repository).items.find(item => item.id === receipts[1].id).recovery);
    await artifacts.hold(repository, receipts[2].id, true); delivery.sync();
    await chat('Clean up old artifacts'); await wait(() => Boolean(delivery.status().artifactPreview)); assert.deepEqual(delivery.status().artifactPreview.remove, [receipts[3].id]);
    await chat('Apply this artifact change'); await wait(() => artifacts.inventory(repository).items.length === 4);
    assert.equal(existsSync(join(directory, 'artifacts', receipts[3].id + '.pipeliner-artifact')), false);
    for (const receipt of receipts.filter((_, index) => index !== 3)) assert.equal(await artifacts.verify(repository, receipt.id), true);
    assert.equal(readFileSync(join(directory, 'artifacts.sqlite')).includes(Buffer.from('one.dmg')), false);
    assert.equal(readFileSync(join(directory, 'artifacts', receipts[0].id + '.pipeliner-artifact')).includes(Buffer.from('private synthetic')), false);
    assert.equal(delivery.status().installer, null); assert.equal(delivery.status().buildQualified, false);
    assert.equal(JSON.stringify(delivery.status()).includes(source), false);
    await artifacts.hold(repository, receipts[2].id, false, { settled: true }); delivery.sync();
    await chat('Pin the latest artifact'); await wait(() => Boolean(delivery.status().artifactPreview)); await delivery.dispatch({ operation: 'cancel' }); assert.equal(artifacts.inventory(repository).items[0].pinned, false);
    await chat('Show retained artifacts'); await wait(() => js("document.querySelectorAll('.artifact-record').length===4"));
    await js("document.getElementById('delivery-inventory').scrollIntoView({block:'start'})");
    window.setSize(420, 760); appearance.dispatch({ operation: 'prepare', changes: { 'appearance.textScale': 2 } }); appearance.dispatch({ operation: 'apply' });
    await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(await js("Array.from(document.querySelectorAll('.artifact-record button,.artifact-record summary')).every(node=>node.getBoundingClientRect().height>=44)"), true);
    await js("(()=>{const card=document.querySelector('.artifact-record');window.scrollTo(0,window.scrollY+card.getBoundingClientRect().top-document.querySelector('.app-nav').getBoundingClientRect().bottom-24)})()");
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await new Promise(resolve => setTimeout(resolve, 100));
    writeFileSync(join(directory, 'qa-capture.png'), (await window.webContents.capturePage()).toPNG(), { flag: 'wx', mode: 0o600 });
    window.setSize(1180, 840); appearance.dispatch({ operation: 'prepare', changes: { 'appearance.textScale': 1 } }); appearance.dispatch({ operation: 'apply' });
  });
};
