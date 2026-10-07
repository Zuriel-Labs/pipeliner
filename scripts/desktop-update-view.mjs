import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Renderer qualification only; never packaged and never connected to a live host channel.
const run = process.env.TEST_ARTIFACT_RUN;
if (process.argv.length !== 2 || !/^\/Volumes\/TESTING\/TestArtifacts\/projects\/pipeliner\/issues\/54\/runs\/\d{8}T\d{6}Z-[a-f0-9]{32}$/.test(run ?? '')) throw Error('update-view-run-required');
const manifest = JSON.parse(await readFile(join(run, 'manifest.json')));
if (manifest.status !== 'running' || manifest.project !== 'pipeliner' || manifest.issue !== '54' || manifest.child_pid !== process.pid
  || manifest.owner_uid !== process.getuid() || manifest.volume_uuid !== '3F381C66-C7CC-4F8F-B3BE-E46151ACF674'
  || manifest.paths.outputs !== process.env.TEST_ARTIFACT_OUTPUTS) throw Error('update-view-run-unverified');
const sources = {};
for (const name of ['desktop/app/updates.mjs', 'desktop/updates/commands.mjs', 'desktop/connections/commands.mjs', 'desktop/prototype/style.css', 'desktop/app/app.css'])
  sources[name] = await readFile(new URL('../' + name, import.meta.url), 'utf8');
const script = `
const source=${JSON.stringify(sources)};
const moduleURL=text=>URL.createObjectURL(new Blob([text],{type:'text/javascript'}));
const connection=moduleURL(source['desktop/connections/commands.mjs']);
const commands=moduleURL(source['desktop/updates/commands.mjs'].replace("'../connections/commands.mjs'",JSON.stringify(connection)));
const renderer=moduleURL(source['desktop/app/updates.mjs'].replace("'./update-commands.mjs'",JSON.stringify(commands)));
const phases=['preparing','staged','verified','replacing','relaunching','repair-required',null];let index=0,revision=1,refreshes=0,updates;
const snapshot=()=>({revision,storageAvailable:false,recoveryRequired:true,scope:'host',policyRevision:null,installedVersion:'0.1.0',values:null,
 sources:[],sourceName:null,sourceConfigured:false,sourceQualified:false,installQualified:false,busy:false,lastCheck:null,upToDate:false,release:null,preview:null,
 maintenance:phases[index]?{phase:phases[index],fromVersion:'0.1.0',toVersion:'0.2.0',installerRecorded:index>0,backupsRecorded:index>1?3:0,candidateRecorded:index>1,replacementRecorded:index>2}:null,
 message:'Desktop maintenance needs verified recovery before work can resume. Keep the installed app and saved data; settings and repositories are preserved.'});
const result=document.getElementById('fixture-result'),requests=[];
window.pipeliner={onUpdates(fn){updates=fn;},async updateRequest(payload){
 requests.push(payload);
 if(payload.operation==='status'){if(Object.keys(payload).length!==1)throw Error('Synthetic status shape changed');if(requests.length>1)refreshes++;}
 else if(payload.operation!=='chat'||payload.text!=='Show Desktop updates')throw Error('Synthetic mutation refused');
 result.textContent='Synthetic host: '+refreshes+' read-only refreshes; no mutation, filesystem or native IPC capability.';return payload.operation==='status'?snapshot():{snapshot:snapshot()};}};
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
const client=await(await import(renderer)).initUpdates({el,message(){},show(){document.getElementById('update-settings').hidden=false;}});
document.getElementById('update-settings').hidden=false;
document.getElementById('settings-updates').setAttribute('aria-pressed','true');
document.getElementById('fixture-next').addEventListener('click',()=>{index=(index+1)%phases.length;revision++;updates(snapshot());});
document.getElementById('fixture-chat').addEventListener('click',()=>client.chat('Show Desktop updates'));
for(const url of [renderer,commands,connection])URL.revokeObjectURL(url);
`;
const dark = sources['desktop/prototype/style.css'].split('@media(prefers-color-scheme:dark){')[1]?.split('@media(forced-colors:active)')[0]?.trim();
if (!dark?.endsWith('}')) throw Error('update-view-dark-tokens-unverified');
const css = sources['desktop/prototype/style.css'] + '\n' + sources['desktop/app/app.css'] + '\n' + dark.slice(0, -1) + ':root{color-scheme:dark}';
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Issue #54 — synthetic recovery renderer</title><style>${css}</style><body><header class="app-head"><strong>Issue #54 · Synthetic renderer check</strong><span class="small">No live app or host access</span></header><main><section id="settings-view"><header class="work-head"><h1>Desktop recovery</h1><button id="fixture-next" class="secondary">Next synthetic state</button><button id="fixture-chat" class="secondary">Synthetic chat view</button><p id="fixture-result" class="small" role="status"></p></header><nav class="settings-categories" aria-label="Settings categories"></nav><section id="chat-view" hidden><form id="composer"><input id="prompt" aria-label="Synthetic chat input"></form></section><p id="announcement" class="visually-hidden" role="status" aria-live="polite"></p></section></main><script type="module">${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
const path = join(manifest.paths.outputs, 'maintenance-recovery-view.html');
await writeFile(path, html, { flag: 'wx', mode: 0o600 });
await writeFile(join(manifest.paths.outputs, 'renderer-source-identity.json'), JSON.stringify({ kind: 'synthetic-update-recovery-renderer',
  files: Object.fromEntries(Object.entries(sources).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])),
  htmlSHA256: createHash('sha256').update(html).digest('hex'), limitations: ['Synthetic host and renderer only; not packaged native, IPC, VoiceOver or Human acceptance', 'Browser-owned scratch routing is not established'] }), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ path, bytes: Buffer.byteLength(html), syntheticOnly: true }));
