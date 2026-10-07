import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, lstat, realpath, readdir, rm, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMacUpdateCommand } from '../desktop/updates/mac.mjs';

if (process.argv.length !== 2 || process.env.NODE_OPTIONS || process.platform !== 'darwin' || process.arch !== 'arm64')
  throw Error('update-exchange-probe-startup-denied');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { validateContext, validateOwnedDataDirectory } = createRequire(import.meta.url)('../desktop/test-storage.cjs');
const storage = validateContext(repository);
if (process.env.TMPDIR !== storage.paths.tmp || !storage.run_path.includes('/pipeliner/issues/54/runs/')) throw Error('update-exchange-probe-run-denied');
const root = join(storage.paths.tmp, 'update-exchange-native'), source = join(root, 'candidate'), target = join(root, 'installed');
const executable = join(root, 'exchange'), app = directory => join(directory, 'Pipeliner.app');
const started = performance.now(), execute = promisify(execFile);
const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', TMPDIR: storage.paths.tmp, PYTHONDONTWRITEBYTECODE: '1' };
const run = (file, args, timeout = 5000) => execute(file, args, { env, timeout, killSignal: 'SIGKILL', maxBuffer: 8192 });
let owner, result, failure, phase = 'fixture-root', failureCode;
const same = (a, b) => ['dev', 'ino', 'uid', 'mode'].every(key => a[key] === b[key]);
async function inspect(path) {
  const info = await lstat(path); assert.equal(await realpath(path), path); assert.equal(info.dev, owner.dev);
  assert.equal(info.uid, process.getuid()); assert(!info.isSymbolicLink() && !(info.mode & 0o077));
  if (info.isDirectory()) for (const name of await readdir(path)) await inspect(join(path, name));
  else assert(info.isFile() && info.nlink === 1);
}
try {
  await mkdir(root, { mode: 0o700 }); owner = await lstat(root); validateOwnedDataDirectory(storage, root);
  phase = 'compile';
  await run('/usr/bin/clang', ['-std=c17', '-D_DARWIN_C_SOURCE', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=13.0',
    join(repository, 'desktop/updates/exchange.c'), '-o', executable], 15000);
  await chmod(executable, 0o700);
  phase = 'volume';
  const info = await run('/usr/sbin/diskutil', ['info', '-plist', '/Volumes/TESTING']);
  const converted = await runMacUpdateCommand('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], new AbortController().signal, info.stdout);
  const volume = JSON.parse(converted.stdout);
  assert.equal(volume.MountPoint, '/Volumes/TESTING'); assert.equal(volume.VolumeUUID, storage.volume_uuid);
  assert.equal(volume.FilesystemType, 'apfs'); assert.equal(typeof volume.GlobalPermissionsEnabled, 'boolean');
  phase = 'fixtures';
  for (const directory of [source, target]) { await mkdir(directory, { mode: 0o700 }); await mkdir(app(directory), { mode: 0o700 }); }
  await writeFile(join(app(source), 'synthetic.txt'), 'candidate', { flag: 'wx', mode: 0o600 });
  await writeFile(join(app(target), 'synthetic.txt'), 'installed', { flag: 'wx', mode: 0o600 });
  const initial = [await lstat(app(source), { bigint: true }), await lstat(app(target), { bigint: true })];
  const args = [source, target, ...initial.flatMap(value => [value.dev.toString(), value.ino.toString()])];
  const unchanged = async () => {
    assert.equal((await lstat(app(source), { bigint: true })).ino, initial[0].ino);
    assert.equal((await lstat(app(target), { bigint: true })).ino, initial[1].ino);
    assert.equal(await readFile(join(app(source), 'synthetic.txt'), 'utf8'), 'candidate');
    assert.equal(await readFile(join(app(target), 'synthetic.txt'), 'utf8'), 'installed');
  };
  phase = 'before-effect-refusals';
  for (const selected of [[], [...args.slice(0, -1), '-1'], [...args.slice(0, -1), '0'],
    [source, source, ...args.slice(2)], [...args.slice(0, -1), (initial[1].ino + 1n).toString()]]) {
    await assert.rejects(run(executable, selected), error => error.code === 2 && error.stdout === '' && error.stderr === 'update-swap-refused\n');
    await unchanged();
  }
  let helperExchanges = 0;
  phase = 'helper';
  if (volume.GlobalPermissionsEnabled) {
    assert.equal((await run(executable, args)).stdout, 'pipeliner-update-exchanged\n'); helperExchanges++;
    assert.equal((await lstat(app(target), { bigint: true })).ino, initial[0].ino);
    assert.equal((await run(executable, [source, target, ...initial.toReversed().flatMap(value => [value.dev.toString(), value.ino.toString()])])).stdout,
      'pipeliner-update-exchanged\n'); helperExchanges++;
  } else await assert.rejects(run(executable, args), error => error.code === 2 && error.stdout === '' && error.stderr === 'update-swap-refused\n');
  await unchanged();
  phase = 'parent-verification';
  const parent = await lstat(source, { bigint: true }), inspectParent = ['--verify-parent', source, parent.dev.toString(), parent.ino.toString()];
  if (volume.GlobalPermissionsEnabled) assert.equal((await run(executable, inspectParent)).stdout, 'pipeliner-update-parent-verified\n');
  else await assert.rejects(run(executable, inspectParent), error => error.code === 2 && error.stdout === '' && error.stderr === 'update-swap-refused\n');
  await unchanged();
  phase = 'kernel';
  const kernel = 'import ctypes,os,sys\nlib=ctypes.CDLL("/usr/lib/libSystem.B.dylib",use_errno=True)\n' +
    'call=lib.renameatx_np\ncall.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]\ncall.restype=ctypes.c_int\n' +
    'fds=[os.open(p,os.O_RDONLY|os.O_DIRECTORY) for p in sys.argv[1:]]\ntry:\n' +
    ' assert call(fds[0],b"Pipeliner.app",fds[1],b"Pipeliner.app",0x32)==0,ctypes.get_errno()\nfinally:\n [os.close(fd) for fd in fds]\n';
  await run('/opt/homebrew/bin/python3', ['-I', '-B', '-c', kernel, source, target]);
  assert.equal((await lstat(app(target), { bigint: true })).ino, initial[0].ino);
  assert.equal((await lstat(app(source), { bigint: true })).ino, initial[1].ino);
  assert.equal(await readFile(join(app(target), 'synthetic.txt'), 'utf8'), 'candidate');
  assert.equal(await readFile(join(app(source), 'synthetic.txt'), 'utf8'), 'installed');
  await run('/opt/homebrew/bin/python3', ['-I', '-B', '-c', kernel, source, target]); await unchanged();
  // Compile the actual private guard into a test-only harness; no production test flags.
  phase = 'acl-guard';
  const harness = join(root, 'acl-check.c'), checker = join(root, 'acl-check');
  await writeFile(harness, '#define main production_main\n#include ' + JSON.stringify(join(repository, 'desktop/updates/exchange.c')) +
    '\n#undef main\n#include <sys/acl.h>\nint main(int argc, char **argv) {\n' +
    ' if (argc != 2) return 1; int fd = open(argv[1], O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW_ANY); struct stat info;\n' +
    ' if (fd < 0 || !protected(fd, &info, 1)) return 2;\n' +
    ' acl_t acl = acl_init(1); acl_entry_t item; unsigned char principal[16] = {1};\n' +
    ' if (!acl || acl_create_entry(&acl, &item) != 0 || acl_set_tag_type(item, ACL_EXTENDED_DENY) != 0\n' +
    ' || acl_set_qualifier(item, principal) != 0 || acl_set_fd_np(fd, acl, ACL_TYPE_EXTENDED) != 0) return 3;\n' +
    ' if (acl_free(acl) != 0 || protected(fd, &info, 1) || close(fd) != 0) return 4; return 0;\n}\n', { flag: 'wx', mode: 0o600 });
  await run('/usr/bin/clang', ['-std=c17', '-D_DARWIN_C_SOURCE', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=13.0', harness, '-o', checker], 15000);
  await chmod(checker, 0o700); await run(checker, [source]); await unchanged();
  result = { kind: 'pipeliner-native-update-exchange', schemaVersion: 1, kernelExchanges: 2, helperExchanges,
    ownershipEnforced: volume.GlobalPermissionsEnabled, helperAcceptance: volume.GlobalPermissionsEnabled ? 'passed' : 'refused-ignored-ownership',
    beforeEffectRefusals: volume.GlobalPermissionsEnabled ? 5 : 6, actualACLGuard: 'passed', installedAppTouched: false,
    parentVerification: volume.GlobalPermissionsEnabled ? 'passed' : 'refused-ignored-ownership',
    powerLoss: 'not-run', elapsedMs: Math.round(performance.now() - started) };
} catch (error) {
  failure = true; failureCode = Number.isInteger(error.code) ? error.code : 'unverified';
  if (phase === 'compile' && typeof error.stderr === 'string')
    await writeFile(join(storage.paths.logs, 'exchange-compile.stderr'), error.stderr.slice(0, 8192), { flag: 'wx', mode: 0o600 });
}
finally {
  if (owner) try {
    validateOwnedDataDirectory(storage, root); assert(same(owner, await lstat(root))); await inspect(root);
    await rm(root, { recursive: true }); await assert.rejects(lstat(root), error => error.code === 'ENOENT');
    if (result) result.fixtureRemoved = true;
  } catch { failure = true; }
}
if (failure) { console.error(JSON.stringify({ error: 'update-exchange-probe-failed', phase, code: failureCode ?? 'cleanup-unverified' })); process.exitCode = 1; }
else console.log(JSON.stringify(result));
