import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import { validateCalendar } from './model.mjs';
const exec = promisify(execFile);
export async function nextCalendar(helper, config, after, signal) {
  validateCalendar(config, after);
  const info = await lstat(helper);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.nlink !== 1 || info.mode & 0o022 || await realpath(helper) !== helper) throw new Error('Calendar helper unavailable');
  const { stdout } = await exec(helper, [JSON.stringify({ ...config, after })], { signal, timeout: 5000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
  const value = JSON.parse(stdout);
  if (Object.keys(value).length !== 1 || !Number.isSafeInteger(value.nextAt) || value.nextAt <= after || value.nextAt > after + 9 * 86400000) throw new Error('Calendar result unavailable');
  return value.nextAt;
}
