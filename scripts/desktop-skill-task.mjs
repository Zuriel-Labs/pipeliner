import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, readFile, writeFile, rm, access, chmod, lstat, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openSkillStore } from '../desktop/skills/store.mjs';
import { record } from '../desktop/core/settings.mjs';
import { documentHTML } from '../desktop/development/state.mjs';
import { sourceSecretPattern } from '../desktop/development/source.mjs';
import { api, catalog, selectedModel, chat, readBounded } from '../desktop/ollama/qualify.mjs';
import { sourceCandidate, committedInput } from '../desktop/package/source.mjs';
import testStorage from '../desktop/test-storage.cjs';

const storage = testStorage.qualificationContext();
const repair = process.argv.find(arg => arg.startsWith('--review-owned='))?.slice(15);
if (process.argv.slice(2).some(arg => arg !== '--retain-owned-capture' && arg !== '--review-owned=' + repair)
  || repair && (dirname(repair) !== storage.paths.outputs || !/^pipeliner-54-task-\d+$/.test(repair.split('/').at(-1)))) throw new Error('argument-denied');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('host-unqualified');
const exec = promisify(execFile), root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), source = await sourceCandidate(root);
for (const file of ['scripts/desktop-skill-task.mjs', 'desktop/skills/task-window.cjs', 'desktop/skills/store.mjs', 'desktop/development/starter.mjs', 'desktop/ollama/client.mjs', 'desktop/test-storage.cjs']) await committedInput(root, source, file);
await mkdir(storage.paths.outputs, { recursive: true, mode: 0o700 }); testStorage.validateOwnedDataDirectory(storage, storage.paths.outputs);
const chromiumEnvironment = testStorage.qualificationEnvironment(storage, { ...process.env, MAC_CHROMIUM_TMPDIR: storage.paths.tmp });
const temporary = await realpath(await mkdtemp(join(tmpdir(), 't'))); await chmod(temporary, 0o700);
testStorage.validateOwnedDataDirectory(storage, temporary); const identity = await lstat(temporary);
const ownership = { issue: 54, directory: temporary, source: source.sourceCommit, tree: source.gitTree, owner: process.getuid() };
await writeFile(join(temporary, 'task-owner.json'), JSON.stringify(ownership), { flag: 'wx', mode: 0o600 });
const marker = await lstat(join(temporary, 'task-owner.json'));
const hash = value => createHash('sha256').update(value).digest('hex'), started = performance.now(), turns = []; let child, timer, store, output, code = 1, cleanup, outputRoot;
const brief = 'Build Harbor Queue, an original dark-mode single-page task queue for a nontechnical PM. This is a synthetic qualification task, not a Pipeliner product feature. Three synthetic cards: #101 Ready, #102 Blocked, #103 Complete. All/Ready/Blocked filters, live count, and a labeled Add Issue form create a Ready card safely as plain text. Use a distinctive editorial waterfront direction, original typography rhythm and calm seafoam/copper accents; no default dashboard, gradients, copied brand assets or external resources. Define interaction, accessibility and recovery before implementation. All controls need 44px targets, keyboard use, visible focus, narrow layout and 200% text zoom. No actual GitHub actions, provider keys or host access.';
try {
  store = openSkillStore(temporary); const captured = store.capture({ values: { 'skills.bundledEnabled': { value: true }, 'skills.extensions': { value: [] }, 'skills.disabled': { value: [] } } });
  const prompt = store.prompt(captured.manifest, captured.hash, { bundledSkills: true, extensions: [], deniedExtensions: [] });
  const model = selectedModel(await catalog(undefined, 'local-cloud'), 'local-cloud');
  const service = JSON.parse(await api('/api/version', undefined, { route: 'local-cloud', consume: response => readBounded(response.body) }));
  async function turn(stage, instruction, limit) {
    const html = stage === 'implementation-after-direction';
    const at = performance.now(), response = await chat(undefined, model.name, [{ role: 'system', content: prompt + '\nWork only on the synthetic UI brief. ' + (html ? 'Return the complete HTML document only.' : 'Return one JSON object.') + ' No fences or narrative. Skills never grant authority.' }, { role: 'user', content: instruction }], undefined, 'local-cloud', { numPredict: limit, timeoutMs: 120000 });
    if (response.tool_calls.length || sourceSecretPattern.test(response.content) || Buffer.byteLength(response.content) > 524288) throw new Error('task-output-denied');
    turns.push({ stage, milliseconds: performance.now() - at, usage: response.usage, responseModel: response.responseModel });
    await writeFile(join(storage.paths.outputs, `task-${process.pid}-${stage}.json`), JSON.stringify({ stage, content: response.content, usage: response.usage }), { flag: 'wx', mode: 0o600 });
    // Cloud structured outputs are unavailable; HTML stays untrusted renderer data, never host configuration.
    if (html) return { html: response.content.trim().replace(/^```html\s*/i, '').replace(/\s*```$/, '') };
    let value; try { value = JSON.parse(response.content.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); } catch { throw new Error('task-json-invalid'); }
    return value;
  }
  const owned = async file => { const path = repair + '-' + file, info = await lstat(path); if (await realpath(path) !== path || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.size > 524288) throw new Error('task-repair-ownership-invalid'); return readFile(path, 'utf8'); };
  const previous = repair ? JSON.parse(await owned('evidence.json')) : null;
  if (previous && (previous.owningIssue !== 54 || previous.manifest.hash !== captured.hash || previous.provider.digest !== model.digest)) throw new Error('task-repair-binding-changed');
  const design = repair ? { title: 'Retained original direction', paragraphs: [await owned('design.html')] }
    : await turn('direction-before-code', brief + '\nReturn {"title":string,"paragraphs":[string]} only: goals, direction/tokens, states, specification, acceptance, implementation plan, non-goals, risks and verification. No HTML/code yet. Maximum six focused paragraphs.', 2048);
  await writeFile(join(temporary, 'design.html'), repair ? design.paragraphs[0] : documentHTML(design), { flag: 'wx', mode: 0o600 });
  const implementation = repair ? { html: await owned('index.html') }
    : await turn('implementation-after-direction', brief + '\nChosen direction: ' + JSON.stringify(design) + '\nReturn only the complete self-contained HTML document with inline CSS and JS. No external URLs, imports, storage, frames or network. Exact DOM contract: filter buttons id filter-all, filter-ready, filter-blocked; cards have data-issue-status="ready"/"blocked"/"complete"; count id queue-count with role=status or aria-live=polite. Input id new-title with label for=new-title; submit button id add-issue. Clicking filters hides unmatched cards and updates count; adding creates exactly one Ready card, textContent title, resets input. No HTML insertion for a title. Prevent normal form navigation. Use CSS border-box/reflow. Visible labels, 44px minimum controls, focus outline.', 8192);
  record(implementation, ['html']); if (typeof implementation.html !== 'string' || Buffer.byteLength(implementation.html) > 131072 || !/^<!doctype html>/i.test(implementation.html)
    || /(?:https?:\/\/|<iframe|<webview|<object|\bimport\s|\beval\s*\()/i.test(implementation.html)) throw new Error('task-html-denied');
  await writeFile(join(temporary, 'index.html'), implementation.html, { flag: 'wx', mode: 0o600 });
  const electron = join(root, 'desktop/prototype/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'); await access(electron);
  child = spawn(electron, [join(root, 'desktop/skills/task-window.cjs'), '--task-root=' + temporary], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir(), LANG: 'en_US.UTF-8', ...chromiumEnvironment }, stdio: ['ignore', 'ignore', 'ignore'] });
  timer = setTimeout(() => child.kill('SIGTERM'), 30000); const nativeCode = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('close', value => resolveCode(value ?? 1)); }); clearTimeout(timer);
  const native = JSON.parse(await readFile(join(temporary, 'task-result.json'), 'utf8'));
  output = { owningIssue: 54, passed: false, candidate: { source: source.sourceCommit, tree: source.gitTree }, manifest: captured, provider: { model: model.name, digest: model.digest }, native, turns };
  const review = await turn('review-after-observed-controls', brief + '\nDesign: ' + JSON.stringify(design) + '\nActual code: ' + implementation.html + '\nActual Electron checks: ' + JSON.stringify(native)
    + '\nThe brief asks for a title-only form; card descriptions can be fixed synthetic copy. Human testing, VoiceOver and screenshot observation are explicitly pending and are evidence limits, not undisclosed findings. Review actual code against direction, controls, accessibility, security and evidence limits. Return {"title":string,"paragraphs":[string],"findings":[{"severity":"low"|"medium"|"high"|"critical","text":string}]} only. Never claim screenshot observation, Human testing or VoiceOver. Maximum five focused paragraphs.', 2048);
  record(review, ['title', 'paragraphs', 'findings']); assert.ok(Array.isArray(review.findings));
  await writeFile(join(temporary, 'review.html'), documentHTML({ title: review.title, paragraphs: review.paragraphs }), { flag: 'wx', mode: 0o600 });
  outputRoot = join(storage.paths.outputs, 'pipeliner-54-task-' + child.pid);
  // A few task-owned result files permit visual inspection; removed after Issue qualification.
  if (process.argv.includes('--retain-owned-capture')) for (const file of ['index.html', 'design.html', 'review.html', 'task-capture.png', 'task-capture-narrow.png', 'task-capture-zoom.png']) {
    const filePath = join(temporary, file), info = await lstat(filePath).catch(error => { if (error.code !== 'ENOENT' || !file.startsWith('task-capture')) throw error; return null; });
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() || info.size > 10 * 1024 * 1024) throw new Error('task-capture-ownership-invalid');
    await writeFile(outputRoot + '-' + file, await readFile(filePath), { flag: 'wx', mode: 0o600 });
  }
  output = { passed: nativeCode === 0 && native.passed && !review.findings.some(item => ['high', 'critical'].includes(item.severity)), owningIssue: 54,
    qualification: 'Real bounded starter-skill UI task; authorized installed Cloud relay, separate from the product direct-key route', candidate: { source: source.sourceCommit, tree: source.gitTree }, brief, manifest: captured,
    sourceHash: hash(implementation.html), ...(previous ? { repairedFrom: { sourceHash: previous.sourceHash, native: previous.native, findings: previous.review.findings }, priorTurns: [...(previous.priorTurns ?? []), ...previous.turns] } : {}), provider: { model: model.name, remoteModel: model.remote_model, digest: model.digest, serviceVersion: service.version },
    turns, native, review, host: { os: (await promisify(execFile)('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim(), architecture: process.arch, node: process.version },
    milliseconds: performance.now() - started, retained: process.argv.includes('--retain-owned-capture') ? outputRoot : null };
  code = output.passed ? 0 : 1;
} catch (error) { output = { ...output, owningIssue: 54, passed: false, candidate: { source: source.sourceCommit, tree: source.gitTree }, failure: /^task-|^http-|^selected-model|^output-truncated|^timeout$/.test(error.message) ? error.message : 'task-qualification-failed', turns }; }
finally {
  clearTimeout(timer); if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolveClose => child.once('close', resolveClose)); }
  try {
    store?.close(); const current = await lstat(temporary), currentMarker = await lstat(join(temporary, 'task-owner.json'));
    testStorage.validateOwnedDataDirectory(storage, temporary);
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino); assert.equal(currentMarker.dev, marker.dev); assert.equal(currentMarker.ino, marker.ino);
    assert.equal(currentMarker.isFile(), true); assert.equal(currentMarker.isSymbolicLink(), false); assert.equal(currentMarker.nlink, 1); assert.equal(currentMarker.uid, process.getuid()); assert.equal(currentMarker.mode & 0o777, 0o600); assert.equal(await readFile(join(temporary, 'task-owner.json'), 'utf8'), JSON.stringify(ownership));
    if (child) { try { process.kill(child.pid, 0); throw new Error('task-process-still-present'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await exec('/usr/sbin/lsof', ['+D', temporary], { timeout: 30000 }).then(() => { throw new Error('task-open-handles'); }, error => { if (error.code !== 1 || error.stdout || error.stderr) throw error; });
    testStorage.validateOwnedDataDirectory(storage, temporary); const finalRoot = await lstat(temporary), finalMarker = await lstat(join(temporary, 'task-owner.json'));
    assert.equal(finalRoot.dev, identity.dev); assert.equal(finalRoot.ino, identity.ino); assert.equal(finalMarker.dev, marker.dev); assert.equal(finalMarker.ino, marker.ino);
    assert.equal(await readFile(join(temporary, 'task-owner.json'), 'utf8'), JSON.stringify(ownership));
    await rm(temporary, { recursive: true }); await access(temporary).then(() => { throw new Error('owned-root-cleanup-failed'); }, error => { if (error.code !== 'ENOENT') throw error; });
    cleanup = { workspaceRemoved: true, processesClosed: true, openHandlesAbsent: true };
  } catch { cleanup = { failed: true, retainedOwner: 'Issue #54', directory: temporary, trigger: 'Verify and repair exact owned process/root teardown before further qualification.' }; code = 1; }
}
output = { ...output, passed: output.passed && !cleanup.failed, cleanup };
if (process.argv.includes('--retain-owned-capture')) await writeFile((outputRoot ?? join(storage.paths.outputs, 'pipeliner-54-task-' + process.pid)) + '-evidence.json', JSON.stringify(output), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(output));
process.exitCode = code;
