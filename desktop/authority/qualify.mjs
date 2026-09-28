import { spawnSync } from 'node:child_process';
import { constants, existsSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const image = 'sha256:b91a367268fe1a89a9446365dae1c5bbcf83491c05e382aae0c05a8acf310e65';
const vm = 'pipeliner-d02';
const marker = 'pipeliner-d02-owned';
const guestWorkspacePattern = /^\/tmp\/pipeliner-d02-[0-9a-f]{12}\/workspace$/;

export function workerArgs(workspace, name, script, extra = []) {
  if (!guestWorkspacePattern.test(workspace) || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid task-owned worker scope');
  return ['run', '--rm', '--name', `pipeliner-d02-${name}`, '--network', 'none',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
    '--pids-limit', '32', '--memory', '128m', '--cpus', '1',
    '-v', `${workspace}:/workspace:rw`, '-w', '/workspace',
    image, 'sh', '-c', script, 'worker', ...extra];
}

export const validateReadback = value => value === 'worker-ok';

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 8192, ...options });
  return { status: result.status, signal: result.signal, error: result.error?.code ?? null,
    stdout: result.stdout?.slice(0, 2000) ?? '', stderr: result.stderr?.slice(0, 2000) ?? '' };
};
const guest = (...args) => run('/opt/homebrew/bin/limactl', ['shell', vm, '--', ...args]);

export function qualify() {
  const started = performance.now();
  const id = randomBytes(6).toString('hex');
  const guestRoot = `/tmp/pipeliner-d02-${id}`;
  const workspace = `${guestRoot}/workspace`;
  const protectedPath = `${guestRoot}/protected/policy.json`;
  const secretPath = `${guestRoot}/protected/synthetic-secret`;
  const hostRoot = mkdtempSync('/private/tmp/pipeliner-d02-host-');
  const hostPolicy = join(hostRoot, 'policy.json');
  const hostSecret = join(hostRoot, 'synthetic-secret');
  const checks = [];
  const report = { macOS: run('/usr/bin/sw_vers', ['-productVersion']).stdout.trim(),
    architecture: process.arch, node: process.version, lima: run('/opt/homebrew/bin/limactl', ['--version']).stdout.trim(),
    nerdctl: guest('nerdctl', '--version').stdout.trim(), image, vm, checks,
    cleanup: { guest: false, host: false, containers: false } };
  const check = (name, condition, detail = null) => checks.push({ name, passed: Boolean(condition), detail });
  let guestReady = false;
  let containerIndex = 0;
  const ownedContainers = [];
  const worker = (name, script, args = []) => {
    containerIndex++;
    const ownedName = `run-${id}-${name}-${containerIndex}`;
    ownedContainers.push(`pipeliner-d02-${ownedName}`);
    return guest('nerdctl', ...workerArgs(workspace, ownedName, script, args));
  };
  try {
    writeFileSync(join(hostRoot, marker), marker);
    writeFileSync(hostPolicy, '{"approved":false}\n');
    writeFileSync(hostSecret, 'SYNTHETIC-SECRET\n');
    const mounts = guest('sh', '-c', 'findmnt -n -t virtiofs,9p,fuse.sshfs -o SOURCE,TARGET,FSTYPE; test ! -e /Users/chris && test ! -e /private');
    check('vm-no-host-mounts', mounts.status === 0 && mounts.stdout.trim() === '', mounts);
    const setup = guest('sh', '-c', `test ! -e ${guestRoot} && mkdir -m 700 ${guestRoot} && printf ${marker} > ${guestRoot}/.marker && mkdir -m 700 ${workspace} ${guestRoot}/protected && printf '{"approved":false}\\n' > ${protectedPath} && printf 'SYNTHETIC-SECRET\\n' > ${secretPath}`);
    guestReady = setup.status === 0;
    check('guest-fixture-setup', guestReady, setup);
    if (!guestReady || !checks[0].passed) return report;
    const protectedBefore = guest('cat', protectedPath).stdout;
    const secretBefore = guest('cat', secretPath).stdout;
    const allowed = worker('allowed', 'printf worker-ok > result.txt');
    const readback = guest('cat', `${workspace}/result.txt`);
    check('permitted-workspace-write', allowed.status === 0 && readback.status === 0 && validateReadback(readback.stdout), { allowed, readback });
    const cases = [
      ['direct-policy-write', 'printf forged > "$1"', [protectedPath]],
      ['credential-read', 'cat "$1"', [secretPath]],
      ['host-policy-write', 'printf forged > "$1"', [hostPolicy]],
      ['traversal-write', 'printf forged > /workspace/../protected/policy.json'],
      ['descendant-write', `sh -c 'printf forged > "$1"' child "$1"`, [protectedPath]],
      ['hardlink-alias', 'ln "$1" /workspace/hardlink', [protectedPath]],
    ];
    const alias = guest('ln', '-s', protectedPath, `${workspace}/alias`);
    check('alias-fixture', alias.status === 0, alias);
    cases.push(['symlink-alias', 'printf forged > /workspace/alias']);
    const hook = guest('sh', '-c', `printf '%s\\n' '#!/bin/sh' 'echo SHELL_HOOK_RAN >&2' 'printf forged > ${protectedPath}' > ${workspace}/postinstall.sh`);
    check('hook-fixture', hook.status === 0, hook);
    cases.push(['package-hook', 'sh /workspace/postinstall.sh']);
    for (const [name, script, args] of cases) {
      const attempt = worker(name, script, args);
      const protectedAfter = guest('cat', protectedPath);
      const secretAfter = guest('cat', secretPath);
      const deniedByBoundary = /No such file or directory|nonexistent directory|Permission denied|Operation not permitted/.test(attempt.stderr);
      check(name, attempt.status !== 0 && deniedByBoundary && (name !== 'package-hook' || attempt.stderr.includes('SHELL_HOOK_RAN'))
        && protectedAfter.stdout === protectedBefore && secretAfter.stdout === secretBefore
        && readFileSync(hostPolicy, 'utf8') === '{"approved":false}\n' && !attempt.stdout.includes('SYNTHETIC-SECRET'), attempt);
    }
    const gitHook = worker('git-hook', `git init -q . && git config user.name Fixture && git config user.email fixture@example.invalid && printf '#!/bin/sh\\necho GIT_HOOK_RAN >&2\\nprintf forged > ${protectedPath}\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && git add result.txt && git commit -q -m test`);
    check('git-hook-denied', gitHook.status !== 0 && gitHook.stderr.includes('GIT_HOOK_RAN')
      && guest('cat', protectedPath).stdout === protectedBefore, gitHook);
    const npmFixture = guest('sh', '-c', `printf '%s\\n' '{"name":"d02-fixture","version":"1.0.0","scripts":{"postinstall":"sh npm-hook.sh"}}' > ${workspace}/package.json && printf '%s\\n' '#!/bin/sh' 'echo NPM_HOOK_RAN >&2' 'printf forged > ${protectedPath}' > ${workspace}/npm-hook.sh`);
    check('npm-fixture', npmFixture.status === 0, npmFixture);
    if (npmFixture.status === 0) {
      const npmHook = worker('npm-hook', 'HOME=/workspace npm_config_cache=/workspace/.npm-cache npm install --offline --no-audit --no-fund');
      check('npm-hook-denied', npmHook.status !== 0 && `${npmHook.stdout}${npmHook.stderr}`.includes('NPM_HOOK_RAN')
        && guest('cat', protectedPath).stdout === protectedBefore, npmHook);
    }
    const network = worker('network', 'test -z "$(ip route)" && ! wget -T 2 -q -O /workspace/net https://example.com');
    check('network-denied', network.status === 0, network);
    const automation = worker('automation', 'test ! -e /usr/bin/osascript && test ! -e /Users && test ! -S /run/containerd/containerd.sock && test ! -S /var/run/docker.sock && test -z "$(ip route)"');
    check('host-automation-and-runtime-sockets-absent', automation.status === 0, automation);
    const environment = worker('environment', 'env | cut -d= -f1');
    const environmentKeys = environment.stdout.split('\n').filter(Boolean).map(line => line.split('=')[0]);
    check('worker-no-inherited-credentials', environment.status === 0 && environment.stdout.length < 2000
      && !environmentKeys.some(key => /^(GH_|GITHUB_|CODEX_|OPENAI_|OLLAMA_|ANTHROPIC_|AWS_|AZURE_|GOOGLE_|.*(?:TOKEN|SECRET|PASSWORD|API_KEY))/i.test(key)),
    { status: environment.status, keys: environmentKeys });
    const processes = worker('processes', `printf 'parent=%s\\n' "$$"; sh -c 'printf "child=%s\\n" "$$"'; ps -o pid,ppid,comm`);
    const pids = [...processes.stdout.matchAll(/(?:parent|child)=(\d+)/g)].map(match => match[1]);
    check('worker-descendant-pid-namespace', processes.status === 0 && pids.length === 2 && pids[0] !== pids[1]
      && !processes.stdout.includes('Electron'), processes);
    const forged = worker('forged-ipc', `printf '{"operation":"pm-apply","approved":true}' > /workspace/policy-request.json`);
    check('forged-pm-apply-no-effect', forged.status === 0 && readFileSync(hostPolicy, 'utf8') === '{"approved":false}\n'
      && guest('cat', protectedPath).stdout === protectedBefore, forged);
    const launchDir = join(hostRoot, 'broker-test');
    const build = run('/usr/bin/clang', ['-x', 'c', '-', '-o', launchDir], { input: '#include <stdio.h>\nint main(void){puts("broker-test-ok");return 0;}\n' });
    const signing = build.status === 0 ? run('/usr/bin/codesign', ['--force', '--sign', '-', launchDir]) : null;
    const signature = signing?.status === 0 ? run('/usr/bin/codesign', ['--verify', '--strict', launchDir]) : null;
    const launch = signature?.status === 0 ? run(launchDir, [], { env: { PATH: '/usr/bin:/bin' } }) : null;
    check('brokered-owned-native-launch', build.status === 0 && signing?.status === 0 && signature?.status === 0
      && launch?.status === 0 && launch.stdout === 'broker-test-ok\n'
      && readFileSync(hostPolicy, 'utf8') === '{"approved":false}\n', { build, signing, signature, launch });
    check('protected-final-state', guest('cat', protectedPath).stdout === protectedBefore
      && guest('cat', secretPath).stdout === secretBefore && readFileSync(hostPolicy, 'utf8') === '{"approved":false}\n'
      && readFileSync(hostSecret, 'utf8') === 'SYNTHETIC-SECRET\n');
  } finally {
    const containers = guest('nerdctl', 'ps', '-a', '--format', '{{.Names}}');
    for (const name of ownedContainers.filter(name => containers.stdout.split('\n').includes(name))) guest('nerdctl', 'rm', '-f', name);
    const containerReadback = guest('nerdctl', 'ps', '-a', '--format', '{{.Names}}');
    report.cleanup.containers = containers.status === 0 && containerReadback.status === 0
      && ownedContainers.every(name => !containerReadback.stdout.split('\n').includes(name));
    const removal = guest('python3', '-c', 'import os,sys,shutil; p=sys.argv[1]; assert p.startswith("/tmp/pipeliner-d02-") and os.path.isfile(p+"/.marker") and open(p+"/.marker").read()=="pipeliner-d02-owned"; shutil.rmtree(p); assert not os.path.exists(p)', guestRoot);
    report.cleanup.guest = removal.status === 0;
    if (hostRoot.startsWith('/private/tmp/pipeliner-d02-host-') && existsSync(join(hostRoot, marker))
      && readFileSync(join(hostRoot, marker), 'utf8') === marker) {
      rmSync(hostRoot, { recursive: true });
      report.cleanup.host = !existsSync(hostRoot);
    }
    report.passed = checks.every(item => item.passed) && Object.values(report.cleanup).every(Boolean);
    report.durationMilliseconds = Math.round(performance.now() - started);
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = qualify();
  if (process.argv[2] === '--output' && process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.passed ? 0 : 1;
}
