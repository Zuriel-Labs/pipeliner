import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextCalendar } from '../desktop/scheduling/calendar.mjs';
const exec = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('host-unqualified');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'pipeliner-calendar-'))), helper = join(directory, 'calendar');
const cases = [
  ['Chicago spring gap', 'America/Chicago', [0], '02:30', '2026-03-08T06:00:00Z', '2026-03-08T08:00:00Z'],
  ['Chicago first repeat', 'America/Chicago', [0], '01:30', '2026-11-01T05:00:00Z', '2026-11-01T06:30:00Z'],
  ['Chicago repeat consumed', 'America/Chicago', [0], '01:30', '2026-11-01T06:30:00Z', '2026-11-08T07:30:00Z'],
  ['Chicago between repeats', 'America/Chicago', [0], '01:30', '2026-11-01T06:45:00Z', '2026-11-08T07:30:00Z'],
  ['Lord Howe half-hour gap', 'Australia/Lord_Howe', [0], '02:15', '2026-10-03T13:30:00Z', '2026-10-03T15:30:00Z'],
  ['Leap day', 'UTC', [2], '09:00', '2028-02-28T12:00:00Z', '2028-02-29T09:00:00Z'],
  ['Year boundary', 'Asia/Tokyo', [5], '00:00', '2026-12-31T14:59:00Z', '2026-12-31T15:00:00Z'],
];
try {
  await exec('/usr/bin/clang', ['-fobjc-arc', '-framework', 'Foundation', '-mmacosx-version-min=13.0', resolve(root, 'desktop/scheduling/calendar.m'), '-o', helper], { timeout: 30000 });
  const started = performance.now();
  for (const [name, timezone, days, time, after, expected] of cases) assert.equal(new Date(await nextCalendar(helper, { timezone, days, time }, Date.parse(after))).toISOString(), new Date(expected).toISOString(), name);
  for (const config of [{ timezone: 'Invalid/Zone', days: [0], time: '12:00' }, { timezone: 'UTC', days: [], time: '12:00' }, { timezone: 'UTC', days: [0, 0], time: '12:00' }, { timezone: 'UTC', days: [7], time: '12:00' }, { timezone: 'UTC', days: [0], time: '24:00' }]) await assert.rejects(nextCalendar(helper, config, 1000));
  const direct = await exec(helper, [JSON.stringify({ after: Date.parse('2026-03-08T06:00:00Z'), timezone: 'America/Chicago', days: [0], time: '02:30' })], { env: { PATH: '/usr/bin:/bin', TZ: 'Asia/Tokyo' }, timeout: 5000 });
  assert.equal(JSON.parse(direct.stdout).nextAt, Date.parse('2026-03-08T08:00:00Z'));
  console.log(JSON.stringify({ nativeCalendar: 'passed', cases: cases.length + 6, durationMs: performance.now() - started, host: process.platform + '-' + process.arch, node: process.version }));
} finally {
  await rm(directory, { recursive: true }); await access(directory).then(() => { throw new Error('calendar-cleanup-unverified'); }, error => { if (error.code !== 'ENOENT') throw error; });
  console.log(JSON.stringify({ cleanup: 'owned-calendar-helper-removed', verified: true }));
}
