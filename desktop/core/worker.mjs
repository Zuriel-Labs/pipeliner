import { spawn } from 'node:child_process';
import { constants, existsSync, mkdirSync, lstatSync, realpathSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalJSON, record } from './settings.mjs';
import { workerToolProgram, developmentWorkerProgram } from '../development/worker-tools.mjs';
import { checkedFiles } from '../development/source.mjs';
import { checkedJSON } from '../tools/schema.mjs';

export const workerDisk = { url: 'https://cloud-images.ubuntu.com/releases/resolute/release-20260720/ubuntu-26.04-server-cloudimg-arm64.img', digest: 'sha256:7bcf159e29ad0000bfed9c57875908c39268f5ed1257f4958fa6a9f5f60edd54' };
export const workerVMConfiguration = `vmType: vz
arch: aarch64
cpus: 2
memory: 1GiB
disk: 8GiB
images:
- location: ${workerDisk.url}
  arch: aarch64
  digest: ${workerDisk.digest}
mounts: []
ssh:
  loadDotSSHPubKeys: false
  forwardAgent: false
  forwardX11: false
containerd:
  system: false
  user: true
propagateProxyEnv: false
hostResolver:
  enabled: false
portForwards:
- guestIP: 0.0.0.0
  proto: any
  guestPortRange: [1, 65535]
  ignore: true
param:
  internal_netplanOptional: "true"
`;
const hash = value => createHash('sha256').update(value).digest('hex');
const cid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const imageId = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const workspacePath = value => typeof value === 'string' && /^\/home\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/\.local\/share\/pipeliner\/workspaces\/[a-f0-9]{32}$/.test(value);
function privateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(path) !== path || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700) throw new Error('Invalid private execution directory');
}
function privateJSON(path) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600 || s.size > 16384) throw new Error('Invalid execution ownership file');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function persist(path, value) {
  const temporary = `${path}.${randomUUID()}`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeFileSync(fd, canonicalJSON(value)); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); const directory = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(directory); } finally { closeSync(directory); } }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

// The program runs only inside the restricted Linux container. No host shell accepts it.
export function restrictedWorkerArgs(manifest, program) {
  record(manifest, ['name', 'nonce', 'runId', 'repository', 'epoch', 'workspace', 'image']);
  if (!/^pipeliner-[a-f0-9]{32}$/.test(manifest.name) || !/^[a-f0-9]{32}$/.test(manifest.nonce)
    || !/^[A-Za-z0-9_-]{1,96}$/.test(manifest.runId) || !/^[A-Za-z0-9_-]{1,96}$/.test(manifest.repository)
    || !Number.isSafeInteger(manifest.epoch) || manifest.epoch < 1 || !workspacePath(manifest.workspace) || !imageId(manifest.image)
    || typeof program !== 'string' || !program.length || Buffer.byteLength(program) > 32768 || program.includes('\0')) throw new Error('Invalid restricted worker manifest');
  return ['create', '--name', manifest.name, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
    '--env', `PIPELINER_RUN_ID=${manifest.runId}`, '--env', `PIPELINER_EPOCH=${manifest.epoch}`,
    '--pids-limit', '32', '--memory', '256m', '--cpus', '1', '--tmpfs', '/tmp:rw,nosuid,noexec,size=16m',
    '--log-driver', 'json-file', '--log-opt', 'max-size=64k', '--log-opt', 'max-file=1',
    '--label', `pipeliner.owner=${manifest.nonce}`, '--label', `pipeliner.run=${manifest.runId}`, '--label', `pipeliner.repository=${manifest.repository}`, '--label', `pipeliner.epoch=${manifest.epoch}`,
    '-v', `${manifest.workspace}:/workspace:rw`, '-w', '/workspace', manifest.image, 'sh', '-c', program];
}

// Host-only, app-owned environment. Never pass this handle to a renderer or worker.
export function openWorkerEnvironment(directory) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Restricted worker unavailable on this host');
  privateDirectory(directory);
  const home = join(directory, 'home'), lima = join(directory, 'lima'), config = join(directory, 'worker.yaml'), marker = join(directory, 'environment.json');
  privateDirectory(home); privateDirectory(lima);
  if (Buffer.byteLength(join(lima, 'engine', 'ha.sock')) > 100) throw new Error('Execution state path exceeds the local socket limit');
  if (!existsSync(marker)) persist(marker, { version: 1, nonce: randomUUID(), configuration: hash(workerVMConfiguration), image: null });
  const ownership = privateJSON(marker);
  record(ownership, ['version', 'nonce', 'configuration', 'image']);
  if (ownership.version !== 1 || !/^[a-f0-9-]{36}$/.test(ownership.nonce) || ownership.configuration !== hash(workerVMConfiguration)
    || ownership.image !== null && !imageId(ownership.image)) throw new Error('Execution environment ownership mismatch');
  if (!existsSync(config)) writeFileSync(config, workerVMConfiguration, { flag: 'wx', mode: 0o600 });
  const configStat = lstatSync(config);
  if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.nlink !== 1 || configStat.uid !== process.getuid() || (configStat.mode & 0o777) !== 0o600
    || readFileSync(config, 'utf8') !== workerVMConfiguration) throw new Error('Execution VM configuration changed');
  const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, LIMA_HOME: lima, LC_ALL: 'C', LIMA_INSTANCE: 'engine' };
  const children = new Set();
  async function command(args, { input, timeout = 30000, maximum = 65536, signal } = {}) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn('/opt/homebrew/bin/limactl', args, { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); children.add(child);
      let output = '', diagnostic = '', bytes = 0, failure = null, cancellationError = null, force;
      const terminate = reason => {
        if (failure) return; failure = reason;
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') cancellationError = error.code ?? 'UNKNOWN'; }
          force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') cancellationError = error.code ?? 'UNKNOWN'; } } }, 2000);
        }
      };
      const timer = setTimeout(() => terminate('Local execution command timed out'), timeout);
      const abort = () => terminate('Local execution command interrupted');
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => { bytes += Buffer.byteLength(data); if (bytes > maximum) terminate('Local execution output limit exceeded'); else output += data; });
      child.stderr.on('data', data => { diagnostic = `${diagnostic}${data}`.slice(-4096); });
      child.once('error', () => { signal?.removeEventListener('abort', abort); clearTimeout(timer); clearTimeout(force); children.delete(child); reject(new Error('Local execution command unavailable')); });
      // Reject only after actual command closure; a cancellation request is never termination evidence.
      child.once('close', (code, exitSignal) => { signal?.removeEventListener('abort', abort); clearTimeout(timer); clearTimeout(force); children.delete(child); if (failure || exitSignal) reject(new Error(failure ?? 'Local execution command interrupted', { cause: cancellationError ? { cancellation: cancellationError } : undefined })); else resolve({ code, output, diagnostic }); });
      child.stdin.on('error', () => {}); child.stdin.end(input);
    });
  }
  const guest = (args, options) => command(['shell', 'engine', '--', ...args], options);
  async function checked(args, options) { const result = await guest(args, options); if (result.code !== 0) throw new Error('Restricted guest command failed', { cause: { command: args.slice(0, 2), code: result.code, diagnostic: result.diagnostic } }); return result.output.trim(); }
  async function inventory() {
    const result = await command(['list', '--json']); if (result.code !== 0) throw new Error('Execution VM inventory unavailable');
    const rows = result.output.trim() ? result.output.trim().split('\n').map(row => JSON.parse(row)) : [];
    if (rows.some(row => row.name !== 'engine')) throw new Error('Unexpected instance in the private execution scope');
    return rows[0] ?? null;
  }
  async function verifyEnvironment() {
    const instance = await inventory();
    if (instance?.status !== 'Running') throw new Error('Execution VM not running');
    const configuration = instance.config;
    if (instance.vmType !== 'vz' || instance.arch !== 'aarch64' || instance.cpus !== 2 || instance.memory !== 1073741824 || instance.disk !== 8589934592
      || (configuration?.mounts ?? []).length || configuration?.ssh?.forwardAgent !== false || configuration?.ssh?.loadDotSSHPubKeys !== false || configuration?.ssh?.forwardX11 !== false
      || configuration?.containerd?.system !== false || configuration?.containerd?.user !== true || configuration?.propagateProxyEnv !== false
      || configuration?.images?.length !== 1 || configuration.images[0].digest !== workerDisk.digest || configuration.images[0].location !== workerDisk.url
      || configuration?.portForwards?.length !== 1 || configuration.portForwards[0].ignore !== true) throw new Error('Execution VM restrictions changed');
    const mounts = await checked(['sh', '-c', 'findmnt -n -t virtiofs,9p,fuse.sshfs -o SOURCE,TARGET,FSTYPE; test ! -e /Users && test ! -e /private && test ! -S /run/host-services/ssh-auth.sock']);
    if (mounts !== '') throw new Error('Host mounts or forwarded agent found');
    const info = JSON.parse(await checked(['nerdctl', 'info', '--format', '{{json .}}']));
    if (!info.SecurityOptions?.some(value => value.includes('rootless'))) throw new Error('Rootless worker runtime unavailable');
    return instance;
  }
  async function inspect(manifest, expectedId = null) {
    const instance = await inventory();
    if (!instance || instance.status === 'Stopped') return { state: 'vm-stopped', id: null };
    if (instance.status !== 'Running') throw new Error('Execution VM state unknown');
    const names = await checked(['nerdctl', 'ps', '-a', '--format', '{{.Names}}']);
    if (!names.split('\n').includes(manifest.name)) { if (expectedId) throw new Error('Owned container disappeared without verified cleanup'); return { state: 'absent', id: null }; }
    const value = JSON.parse(await checked(['nerdctl', 'inspect', '--format', '{{json .}}', manifest.name]));
    const native = JSON.parse(await checked(['nerdctl', 'inspect', '--mode=native', '--format', '{{json .}}', manifest.name]));
    const actualImage = await checked(['nerdctl', 'image', 'inspect', '--mode=native', '--format', '{{.Image.Target.Digest}}', native.Image]);
    const labels = value.Config?.Labels;
    if (!cid(value.Id) || expectedId && value.Id !== expectedId || value.Name.replace(/^\//, '') !== manifest.name || native.ID !== value.Id || actualImage !== manifest.image
      || labels?.['pipeliner.owner'] !== manifest.nonce || labels?.['pipeliner.run'] !== manifest.runId || labels?.['pipeliner.repository'] !== manifest.repository || labels?.['pipeliner.epoch'] !== String(manifest.epoch)) throw new Error('Owned container identity mismatch');
    const spec = native.Spec, resources = spec?.linux?.resources;
    if (spec?.process?.noNewPrivileges !== true || spec?.root?.readonly !== true || Object.values(spec.process.capabilities ?? {}).some(value => value?.length)
      || !['pid', 'network'].every(type => spec.linux.namespaces.some(n => n.type === type && !n.path))
      || resources?.pids?.limit !== 32 || resources?.memory?.limit !== 268435456 || resources?.cpu?.quota !== 100000 || resources?.cpu?.period !== 100000
      || value.HostConfig?.NetworkMode !== 'none' || value.HostConfig.Privileged !== false || !['', 'no'].includes(value.HostConfig.RestartPolicy?.Name)) throw new Error('Owned container restrictions changed');
    const state = value.State?.Status || (!value.State?.Running && value.State?.Pid === 0 && value.State?.StartedAt === '' ? 'created' : 'unknown');
    if (!['created', 'running', 'exited'].includes(state)) throw new Error('Owned container state unknown');
    return { state, id: value.Id, exitCode: value.State.ExitCode, pid: value.State.Pid };
  }
  return Object.freeze({
    async prepare() {
      let instance = await inventory();
      if (!instance || instance.status === 'Stopped') {
        const result = await command(['start', '--tty=false', '--name=engine', ...(instance ? ['engine'] : [config])], { timeout: 600000, maximum: 1048576 });
        if (result.code !== 0) throw new Error('Restricted execution VM provisioning failed');
      }
      const verified = await verifyEnvironment();
      if (!ownership.image) {
        const dockerfile = readFileSync(fileURLToPath(new URL('../authority/Dockerfile', import.meta.url)), 'utf8');
        const tag = `pipeliner-worker:${hash(dockerfile).slice(0, 16)}`;
        const context = `/tmp/pipeliner-build-${randomUUID().replaceAll('-', '')}`;
        await checked(['mkdir', '-m', '700', context]);
        try { await checked(['nerdctl', 'build', '--tag', tag, '--file', '-', context], { input: dockerfile, timeout: 300000, maximum: 1048576 }); }
        finally { await checked(['python3', '-c', 'import os,sys,shutil; p=sys.argv[1]; assert p.startswith("/tmp/pipeliner-build-") and "/" not in p[5:] and os.path.isdir(p) and not os.path.islink(p); shutil.rmtree(p)', context]); }
        const image = JSON.parse(await checked(['nerdctl', 'image', 'inspect', '--mode=native', '--format', '{{json .}}', tag]));
        if (!imageId(image.Image?.Target?.digest) || image.ImageConfig?.architecture !== 'arm64' || image.ImageConfig?.os !== 'linux') throw new Error('Worker image identity unavailable'); ownership.image = image.Image.Target.digest; persist(marker, ownership);
      }
      const actual = JSON.parse(await checked(['nerdctl', 'image', 'inspect', '--mode=native', '--format', '{{json .}}', ownership.image]));
      if (actual.Image?.Target?.digest !== ownership.image) throw new Error('Worker image changed');
      const guestHome = verified.config.user.home;
      if (!/^\/home\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(guestHome)) throw new Error('Private guest workspace location unavailable');
      return { image: ownership.image, disk: workerDisk.digest, configuration: ownership.configuration, workspaceRoot: `${guestHome}/.local/share/pipeliner/workspaces` };
    },
    inventory, inspect,
    async create(manifest, program) {
      await verifyEnvironment();
      if (manifest.image !== ownership.image || (await inspect(manifest)).state !== 'absent') throw new Error('Worker creation scope conflict');
      if (!workspacePath(manifest.workspace)) throw new Error('Invalid persistent worker workspace');
      await checked(['python3', '-c', 'import os,sys,stat; p,r=sys.argv[1:]; m=p+".owner"; b=os.path.dirname(p); assert "/.local/share/pipeliner/workspaces/" in p; os.makedirs(b,mode=0o700,exist_ok=True); assert os.path.realpath(b)==b and os.stat(b).st_uid==os.getuid();\nif os.path.lexists(p):\n s=os.lstat(p); assert stat.S_ISDIR(s.st_mode) and s.st_uid==os.getuid() and os.path.isfile(m) and open(m).read()==r\nelse:\n os.mkdir(p,0o700); f=os.open(m,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); os.write(f,r.encode()); os.close(f)', manifest.workspace, manifest.runId]);
      const id = await checked(['nerdctl', ...restrictedWorkerArgs(manifest, program)]);
      if (!cid(id)) throw new Error('Worker creation identity unavailable');
      await inspect(manifest, id); return id;
    },
    async start(manifest, id) { const before = await inspect(manifest, id); if (!['created', 'exited'].includes(before.state)) throw new Error('Worker cannot start from this state'); await checked(['nerdctl', 'start', id]); return inspect(manifest, id); },
    async tool(manifest, id, request, { signal, mayRestart = () => true } = {}) {
      const shapes = { seed: ['files'], list: [], read: ['path'], write: ['path', 'content', 'mode', 'beforeHash'], run: ['command', 'timeoutMs'], export: [] };
      if (!Object.hasOwn(shapes, request.operation)) throw new Error('Worker tool unavailable');
      record(request, ['operation', ...shapes[request.operation]], request.operation === 'run' ? ['input'] : []);
      if (Object.hasOwn(request, 'input')) checkedJSON(request.input, 'data');
      if (request.operation === 'seed') checkedFiles(request.files);
      else canonicalJSON(request);
      if (request.operation === 'run' && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 300000)) throw new Error('Worker command deadline invalid');
      const input = JSON.stringify({ ...request, runId: manifest.runId, epoch: manifest.epoch });
      if (Buffer.byteLength(input) > 24 * 1024 * 1024) throw new Error('Worker tool input limit exceeded');
      if ((await inspect(manifest, id)).state !== 'running') throw new Error('Worker tool requires running owned container');
      let result;
      try {
        const raw = await checked(['nerdctl', 'exec', '--workdir', '/workspace', '-i', id, 'node', '-e', workerToolProgram], {
          input, signal, timeout: request.operation === 'run' ? request.timeoutMs + 3500 : 30000,
          maximum: request.operation === 'export' ? 24 * 1024 * 1024 : 1048576,
        });
        result = JSON.parse(raw); record(result, ['ok'], result.ok === true ? ['result'] : ['error']);
        if (typeof result.ok !== 'boolean' || result.ok === true && !Object.hasOwn(result, 'result')) throw new Error('Worker tool result invalid');
      } finally {
        // A command can spawn detached descendants. Stop the entire owned container before another tool observes source.
        if (request.operation === 'run') {
          await this.terminate(manifest, id);
          if (!signal?.aborted && mayRestart()) await this.start(manifest, id);
        }
      }
      signal?.throwIfAborted(); await inspect(manifest, id);
      return result;
    },
    async terminate(manifest, id) {
      let before = await inspect(manifest, id);
      if (before.state === 'created') { await checked(['nerdctl', 'rm', before.id]); before = await inspect(manifest); }
      if (before.state === 'running') {
        await checked(['nerdctl', 'stop', '--time', '10', before.id], { timeout: 15000 }); before = await inspect(manifest, before.id);
      }
      if (!['exited', 'absent', 'vm-stopped'].includes(before.state)) throw new Error('Worker termination not verified');
      return before;
    },
    async output(manifest, id) {
      const observation = await inspect(manifest, id); if (observation.state !== 'exited' || observation.exitCode !== 0) throw new Error('Worker result not successful');
      return checked(['nerdctl', 'logs', id], { maximum: 8192 });
    },
    async remove(manifest, id) {
      const observation = await this.terminate(manifest, id);
      if (observation.id) { await checked(['nerdctl', 'rm', observation.id]); if ((await inspect(manifest)).state !== 'absent') throw new Error('Owned container cleanup not verified'); }
    },
    async removeWorkspace(manifest) {
      restrictedWorkerArgs(manifest, developmentWorkerProgram);
      await verifyEnvironment();
      if ((await inspect(manifest)).state !== 'absent') throw new Error('Owned container must be removed before workspace cleanup');
      const result = await checked(['python3', '-c', 'import os,sys,stat,shutil; p,r=sys.argv[1:]; m=p+".owner"; b=os.path.dirname(p); assert os.path.realpath(b)==b and os.stat(b).st_uid==os.getuid();\nif os.path.lexists(p) or os.path.lexists(m):\n t=os.lstat(m); assert stat.S_ISREG(t.st_mode) and t.st_uid==os.getuid() and t.st_nlink==1; f=os.open(m,os.O_RDONLY|os.O_NOFOLLOW); assert os.read(f,1024).decode()==r; os.close(f)\n if os.path.lexists(p):\n  s=os.lstat(p); assert stat.S_ISDIR(s.st_mode) and s.st_uid==os.getuid(); shutil.rmtree(p)\n os.unlink(m)\nassert not os.path.lexists(p) and not os.path.lexists(m); print("removed")', manifest.workspace, manifest.runId]);
      if (result !== 'removed') throw new Error('Owned workspace cleanup not verified');
      return { workspaceRemoved: true };
    },
    async stop() {
      const instance = await inventory();
      if (!instance) return;
      if (instance?.status === 'Running') { const r = await command(['stop', 'engine'], { timeout: 30000 }); if (r.code !== 0) throw new Error('Execution VM stop failed'); }
      if ((await inventory())?.status !== 'Stopped') throw new Error('Execution VM stop not verified');
    },
    async destroy() {
      if (children.size) throw new Error('Execution commands still active');
      if (privateJSON(marker).nonce !== ownership.nonce || readFileSync(config, 'utf8') !== workerVMConfiguration) throw new Error('Execution teardown ownership mismatch');
      const instance = await inventory();
      if (instance) { if (instance.status === 'Running') await this.stop(); const result = await command(['delete', 'engine'], { timeout: 30000 }); if (result.code !== 0) throw new Error('Execution VM deletion failed'); }
      if (await inventory()) throw new Error('Execution VM deletion not verified');
      return { instanceRemoved: true, ownedImageRemovedWithDisk: true, commandsClosed: children.size === 0 };
    },
  });
}
