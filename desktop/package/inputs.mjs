import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
export { packagedCodexPath } from '../codex/executable.mjs';

// Fixed reviewed runtime inputs. Repository docs, tests, launchers and home skills are never selected.
const paths = [
  'LICENSE', ...['project','config','qa','showcase','release-cycle','cleanup'].map(n=>'scripts/lib/'+n+'.mjs'), 'desktop/authority/Dockerfile', 'desktop/prototype/style.css',
  ...['main.cjs','preload.cjs','index.html','app.css','app.mjs','background.mjs','development.mjs','issues.mjs','pipelines.mjs','scheduling.mjs','skills.mjs','tools.mjs','privacy.mjs','workspaces.mjs'].map(n=>'desktop/app/'+n),
  ...['commands.mjs','host.mjs','manager.mjs','native.mjs'].map(n=>'desktop/background/'+n),
  ...['commands.mjs','github.mjs','manager.mjs','native-entry.mjs','providers.mjs','vault.mjs'].map(n=>'desktop/connections/'+n),
  ...['control.mjs','execution.mjs','identity.mjs','policy.mjs','reliability.mjs','runtime.mjs','settings.mjs','storage.mjs','worker.mjs'].map(n=>'desktop/core/'+n),
  ...['commands.mjs','engine.mjs','github.mjs','integration.mjs','manager.mjs','source.mjs','starter.mjs','state.mjs','worker-tools.mjs'].map(n=>'desktop/development/'+n),
  ...['device.mjs','repository-git.mjs','operations.mjs','transport.mjs'].map(n=>'desktop/github/'+n),
  ...['commands.mjs','github.mjs','manager.mjs','model.mjs'].map(n=>'desktop/issues/'+n),
  ...['commands.mjs','manager.mjs','model.mjs'].map(n=>'desktop/pipelines/'+n),
  ...['backup.mjs','commands.mjs','files.mjs','manager.mjs','migration.mjs','model.mjs','records.mjs','store.mjs'].map(n=>'desktop/privacy/'+n),
  ...['commands.mjs','github.mjs','local.mjs','manager.mjs','store.mjs'].map(n=>'desktop/repositories/'+n),
  ...['calendar.mjs','commands.mjs','manager.mjs','model.mjs','read-cache.mjs','scheduler.mjs'].map(n=>'desktop/scheduling/'+n),
  ...['commands.mjs','manager.mjs','package.mjs','source.mjs','store.mjs'].map(n=>'desktop/skills/'+n),
  ...['bindings.mjs','commands.mjs','connections.mjs','invoke.mjs','manager.mjs','package.mjs','schema-worker.mjs','schema.mjs','store.mjs','transport.mjs'].map(n=>'desktop/tools/'+n),
  'desktop/codex/executable.mjs', 'desktop/codex/client.mjs', 'desktop/ollama/client.mjs',
];
const allowed = new Set(paths), required = ['LICENSE','desktop/app/main.cjs','desktop/app/preload.cjs','desktop/app/index.html','desktop/prototype/style.css','desktop/development/starter.mjs','desktop/authority/Dockerfile'];
function checkedPath(value) {
  if(typeof value!=='string'||!value||value.length>512||isAbsolute(value)||value.includes('\\')||/[\x00-\x1f\x7f]/.test(value)||value.split('/').some(part=>!part||part==='.'||part==='..')) throw new Error('package-input-path-invalid');
}
export function runtimeInputs(files) {
  if(!Array.isArray(files)||files.length>8192)throw new Error('package-input-list-invalid');
  const seen=new Set();
  for(const file of files){checkedPath(file);if(seen.has(file))throw new Error('package-input-duplicate');seen.add(file);}
  if(required.some(file=>!seen.has(file)))throw new Error('package-runtime-missing');
  return files.filter(file=>allowed.has(file)).sort();
}
export async function readPackageInput(root, relative, expected) {
  let file;
  try {
    checkedPath(relative);
    if(!Buffer.isBuffer(expected)||expected.length>2*1024**2||await realpath(root)!==root)throw new Error();
    const path=join(root,relative), parent=dirname(path);
    if(await realpath(parent)!==parent)throw new Error();
    file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const before=await file.stat();
    if(!before.isFile()||before.nlink!==1||before.uid!==process.getuid()||before.size!==expected.length)throw new Error();
    const bytes=await file.readFile(), after=await file.stat(), current=await lstat(path);
    if(!bytes.equals(expected)||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||after.nlink!==1
      ||current.isSymbolicLink()||current.dev!==before.dev||current.ino!==before.ino||await realpath(parent)!==parent)throw new Error();
    return bytes;
  } catch { throw new Error('package-input-unverified'); }
  finally { await file?.close(); }
}
