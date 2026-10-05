import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, realpath, mkdir, readFile, writeFile, readdir, lstat, rm, rename, access, statfs } from 'node:fs/promises';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runtimeInputs, readPackageInput } from '../desktop/package/inputs.mjs';
import { sourceCandidate, committedInput } from '../desktop/package/source.mjs';
import { backgroundPlist, backgroundBundleId } from '../desktop/background/native.mjs';
import { createPackageWithOptions, getRawHeader, extractFile, listPackage, statFile } from '../desktop/package/node_modules/@electron/asar/lib/asar.js';
import { flipFuses, getCurrentFuseWire, FuseVersion } from '../desktop/package/node_modules/@electron/fuses/dist/index.js';

// Local review delivery only. Never register a service, install, notarize or publish from this builder.
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..'), exec = promisify(execFile);
if(process.argv.length!==2)throw new Error('package-argument-denied');
if(process.platform!=='darwin'||process.arch!=='arm64'||Number(process.versions.node.split('.')[0])<22)throw new Error('package-host-unqualified');
const candidate=await sourceCandidate(source);
const temporary=await realpath(await mkdtemp(join(tmpdir(),'pipeliner-54-review-build-')));
const stage=join(temporary,'stage'), distribution=join(temporary,'distribution'), app=join(distribution,'Pipeliner.app');
const env={PATH:dirname(process.execPath)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',HOME:temporary,TMPDIR:temporary,LANG:'en_US.UTF-8'};
const command=(file,args,options={})=>exec(file,args,{env,timeout:60000,maxBuffer:1024*1024,...options});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fileHash(path){const value=createHash('sha256');for await(const bytes of createReadStream(path))value.update(bytes);return value.digest('hex');}
const inputs=[];
async function stageSource(file){const bytes=await committedInput(source,candidate,file);const target=join(stage,file);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{flag:'wx',mode:0o600});inputs.push({path:file,sha256:hash(bytes)});return target;}
async function download(name,url,bytes,digest){
  const path=join(temporary,name);
  await command('/usr/bin/curl',['--fail','--silent','--show-error','--location','--proto','=https','--proto-redir','=https','--connect-timeout','30','--max-time','600','--max-filesize',String(bytes),'--output',path,url],{timeout:610000,maxBuffer:8192});
  if((await lstat(path)).size!==bytes||await fileHash(path)!==digest)throw new Error('package-download-unverified');return path;
}
const electron={version:'44.4.5',bytes:130418529,sha256:'a212eee63ba2f45fd83bd28f77a3e3313a336ad17a4c25adf617942eef5e0e2c',url:'https://github.com/electron/electron/releases/download/v44.4.5/electron-v44.4.5-darwin-arm64.zip'};
const codex={version:'0.160.0',bytes:95893648,sha256:'07c3c7ca376a8f791115342f53138dda37e97cfa29b8125d0652d93784894b5d',binarySha256:'112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b',url:'https://github.com/openai/codex/releases/download/rust-v0.160.0/codex-aarch64-apple-darwin.tar.gz'};
let retained=false;
try {
  const capacity=await statfs(temporary);if(capacity.bavail*capacity.bsize<4*1024**3)throw new Error('package-capacity-unavailable');
  await mkdir(stage,{mode:0o700});await mkdir(distribution,{mode:0o700});
  for(const file of runtimeInputs(candidate.files))await stageSource(file);
  for(const file of ['package.json','package-lock.json'])await stageSource(file);
  const npm=(await command('/usr/bin/which',['npm'])).stdout.trim();if(!isAbsolute(npm))throw new Error('package-npm-unavailable');
  const userConfig=join(temporary,'npm-user.conf'),globalConfig=join(temporary,'npm-global.conf');
  for(const path of [userConfig,globalConfig])await writeFile(path,'',{flag:'wx',mode:0o600});
  await command(npm,['ci','--ignore-scripts','--no-audit','--no-fund','--userconfig='+userConfig,'--globalconfig='+globalConfig,'--cache='+join(temporary,'npm-cache')],{cwd:stage,timeout:180000});
  await rm(join(stage,'node_modules/.bin'),{recursive:true,force:true});await rm(join(stage,'node_modules/.package-lock.json'),{force:true});
  const lock=JSON.parse(await readFile(join(stage,'package-lock.json'),'utf8'));
  const packages=await readdir(join(stage,'node_modules'));const expected=Object.keys(lock.packages).filter(p=>p.startsWith('node_modules/')).map(p=>p.slice(13)).sort();
  if(JSON.stringify(packages.sort())!==JSON.stringify(expected))throw new Error('package-dependencies-unexpected');
  for(const name of packages){const manifest=JSON.parse(await readFile(join(stage,'node_modules',name,'package.json'),'utf8'));if(manifest.version!==lock.packages['node_modules/'+name].version||manifest.license!==lock.packages['node_modules/'+name].license)throw new Error('package-dependency-unverified');}
  async function inventory(directory,prefix=''){
    for(const name of (await readdir(directory)).sort()){
      const path=join(directory,name),file=prefix?prefix+'/'+name:name,info=await lstat(path);
      if(info.isSymbolicLink()||info.uid!==process.getuid())throw new Error('package-dependency-type-invalid');
      if(info.isDirectory())await inventory(path,file);
      else {if(!info.isFile()||info.nlink!==1||info.size>2*1024**2)throw new Error('package-dependency-type-invalid');
        const bytes=await readPackageInput(stage,file,await readFile(path));inputs.push({path:file,sha256:hash(bytes)});}
    }
  }
  await inventory(join(stage,'node_modules'),'node_modules');
  const manifest={name:'@zuriel-labs/pipeliner-desktop',productName:'Pipeliner',version:'0.1.0',private:true,type:'module',main:'desktop/app/main.cjs',license:'MIT',dependencies:{ajv:'8.20.0',yaml:'2.9.1'}};
  await writeFile(join(stage,'package.json'),JSON.stringify(manifest,null,2)+'\n');await rm(join(stage,'package-lock.json'));
  // Replace source-manifest records with the exact generated runtime manifest.
  for(let i=inputs.length-1;i>=0;i--)if(['package.json','package-lock.json'].includes(inputs[i].path))inputs.splice(i,1);
  inputs.push({path:'package.json',sha256:hash(await readFile(join(stage,'package.json')))});
  const electronZip=await download('electron.zip',electron.url,electron.bytes,electron.sha256);
  const runtime=join(temporary,'electron');await command('/usr/bin/ditto',['-x','-k',electronZip,runtime]);
  if((await readFile(join(runtime,'version'),'utf8')).trim()!==electron.version)throw new Error('package-electron-version');
  await rename(join(runtime,'Electron.app'),app);
  const contents=join(app,'Contents'),resources=join(contents,'Resources'),helpers=join(resources,'helpers'),archive=join(resources,'app.asar');
  await rm(join(resources,'default_app.asar'));await mkdir(helpers,{mode:0o700});
  for(const name of ['LICENSE','LICENSES.chromium.html']){await access(join(runtime,name));await writeFile(join(resources,name),await readFile(join(runtime,name)),{flag:'wx',mode:0o600});}
  await createPackageWithOptions(stage,archive,{});
  const headerSha256=hash(getRawHeader(archive).headerString), archiveFiles=listPackage(archive).map(file=>file.slice(1)).filter(file=>!('files' in statFile(archive,file,false))).sort();
  if(JSON.stringify(archiveFiles)!==JSON.stringify(inputs.map(v=>v.path).sort()))throw new Error('package-archive-content-unexpected');
  for(const input of inputs){const value=statFile(archive,input.path,false);if(value.unpacked||value.link||value.integrity?.algorithm!=='SHA256'||hash(extractFile(archive,input.path,false))!==input.sha256)throw new Error('package-archive-input-unverified');}
  const plist=join(contents,'Info.plist');
  const set=async(key,value)=>command('/usr/libexec/PlistBuddy',['-c','Set :'+key+' '+value,plist]);
  await set('CFBundleIdentifier',backgroundBundleId);await set('CFBundleName','Pipeliner');await set('CFBundleDisplayName','Pipeliner');await set('CFBundleExecutable','Pipeliner');await set('CFBundleVersion','0.1.0');await set('CFBundleShortVersionString','0.1.0');
  await rename(join(contents,'MacOS/Electron'),join(contents,'MacOS/Pipeliner'));
  for(const key of ['NSCameraUsageDescription','NSMicrophoneUsageDescription','NSAudioCaptureUsageDescription','NSBluetoothPeripheralUsageDescription','NSBluetoothAlwaysUsageDescription','NSAppTransportSecurity','ElectronAsarIntegrity'])await command('/usr/libexec/PlistBuddy',['-c','Delete :'+key,plist]);
  for(const instruction of ['Add :ElectronAsarIntegrity dict','Add :ElectronAsarIntegrity:Resources/app.asar dict','Add :ElectronAsarIntegrity:Resources/app.asar:algorithm string SHA256','Add :ElectronAsarIntegrity:Resources/app.asar:hash string '+headerSha256])await command('/usr/libexec/PlistBuddy',['-c',instruction,plist]);
  const fuseSettings=[false,true,false,false,true,true,true,false,true];
  await flipFuses(app,{version:FuseVersion.V1,strictlyRequireAllFuses:true,...Object.fromEntries(fuseSettings.map((v,i)=>[i,v]))});
  const fuses=await getCurrentFuseWire(app);if(fuses.version!=='1'||fuseSettings.some((v,i)=>fuses[i]!==(v?49:48))||Object.keys(fuses).length!==10)throw new Error('package-fuse-readback-failed');
  const nativeRoot=join(temporary,'native');await mkdir(nativeRoot,{mode:0o700});
  const nativeInputs={};
  for(const file of ['desktop/connections/secure-entry.m','desktop/scheduling/calendar.m','desktop/github/git-credential.c','desktop/background/bootstrap.m']){
    const bytes=await committedInput(source,candidate,file),path=join(nativeRoot,file.split('/').at(-1));await writeFile(path,bytes,{flag:'wx',mode:0o600});nativeInputs[file]=hash(bytes);
  }
  const compile=async(name,file,args)=>command('/usr/bin/clang',['-Wall','-Wextra','-Werror','-mmacosx-version-min=13.0',...args,join(nativeRoot,file),'-o',join(helpers,name)]);
  await compile('secure-entry','secure-entry.m',['-fobjc-arc','-framework','AppKit']);
  await compile('calendar','calendar.m',['-fobjc-arc','-framework','Foundation']);
  await compile('git-credential','git-credential.c',[]);
  await compile('background','bootstrap.m',['-fobjc-arc','-framework','AppKit','-framework','Security','-framework','ServiceManagement']);
  const service=join(contents,'Library/LaunchServices');await mkdir(service,{recursive:true,mode:0o700});await rename(join(helpers,'background'),join(service,'PipelinerBackground'));
  await mkdir(join(contents,'Library/LaunchAgents'),{recursive:true,mode:0o700});await writeFile(join(contents,'Library/LaunchAgents',backgroundBundleId+'.background.plist'),backgroundPlist(),{flag:'wx',mode:0o600});
  const codexTar=await download('codex.tar.gz',codex.url,codex.bytes,codex.sha256);
  const entries=(await command('/usr/bin/tar',['-tzf',codexTar])).stdout.trim();if(entries!=='codex-aarch64-apple-darwin')throw new Error('package-codex-archive-unexpected');
  await command('/usr/bin/tar',['-xzf',codexTar,'-C',helpers]);await rename(join(helpers,entries),join(helpers,'codex'));
  if(await fileHash(join(helpers,'codex'))!==codex.binarySha256||(await command(join(helpers,'codex'),['--version'])).stdout.trim()!=='codex-cli '+codex.version)throw new Error('package-codex-unverified');
  await command('/usr/bin/codesign',['--verify','--strict',join(helpers,'codex')]);
  const license=await download('codex-LICENSE','https://raw.githubusercontent.com/openai/codex/rust-v0.160.0/LICENSE',10926,'d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc');
  await writeFile(join(resources,'Codex-LICENSE'),await readFile(license),{flag:'wx',mode:0o600});
  // Ad hoc signing supplies local integrity only; Developer ID/notarization are pending.
  const entitlements=join(temporary,'electron-entitlements.plist');
  await writeFile(entitlements,'<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>');
  const sign=async(path,jit=false)=>command('/usr/bin/codesign',['--force','--sign','-','--options','runtime','--timestamp=none',...(jit?['--entitlements',entitlements]:[]),path]);
  const frameworkRoot=join(contents,'Frameworks');
  async function nativeBinaries(directory){
    for(const name of await readdir(directory)){const path=join(directory,name),info=await lstat(path);if(info.isSymbolicLink())continue;
      if(info.isDirectory())await nativeBinaries(path);else if(info.isFile()&&(info.mode&0o111)){const kind=(await command('/usr/bin/file',['-b',path])).stdout;if(kind.startsWith('Mach-O'))await sign(path);}}
  }
  await nativeBinaries(frameworkRoot);
  for(const name of await readdir(frameworkRoot)){const path=join(frameworkRoot,name);if(name.endsWith('.app')||name.endsWith('.framework'))await sign(path,name.endsWith('.app'));}
  for(const name of ['secure-entry','calendar','git-credential'])await sign(join(helpers,name));await sign(join(service,'PipelinerBackground'));
  await sign(app,true);await command('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  const current=await sourceCandidate(source);if(current.sourceCommit!==candidate.sourceCommit||current.gitTree!==candidate.gitTree)throw new Error('package-source-changed');
  const dmg=join(temporary,'Pipeliner-0.1.0-mac-arm64-review.dmg');
  await command('/usr/bin/hdiutil',['create','-volname','Pipeliner Review','-srcfolder',distribution,'-format','UDZO','-ov',dmg],{timeout:180000});
  await command('/usr/bin/hdiutil',['verify',dmg],{timeout:180000});
  const report={kind:'local-mac-review',...candidate,files:undefined,buildRoot:temporary,app,dmg,sourceInputs:inputs,nativeInputs,electron,codex,archive:{sha256:await fileHash(archive),headerSha256},fuses,dmgSha256:await fileHash(dmg),signing:'ad-hoc-local-integrity',pending:['Developer ID and notarization','actual packaged native QA','Human PM acceptance','Windows/Linux'],retained:{owner:'Issue #54',trigger:'replace candidate or finish PM testing'},versions:{node:process.versions.node,os:(await command('/usr/bin/sw_vers',['-productVersion'])).stdout.trim(),architecture:process.arch}};
  await writeFile(join(temporary,'build.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  for(const path of [stage,nativeRoot,runtime,electronZip,codexTar,license,entitlements,userConfig,globalConfig,join(temporary,'npm-cache')])await rm(path,{recursive:true,force:true});
  retained=true;console.log(JSON.stringify({built:true,sourceCommit:candidate.sourceCommit,gitTree:candidate.gitTree,app,dmg,dmgSha256:report.dmgSha256,buildRecord:join(temporary,'build.json'),signing:report.signing,pending:report.pending}));
} finally {
  if(!retained){await rm(temporary,{recursive:true,force:true});await access(temporary).then(()=>{throw new Error('package-cleanup-failed');},e=>{if(e.code!=='ENOENT')throw e;});console.log(JSON.stringify({cleanup:'owned-failed-build-removed',verified:true}));}
}
