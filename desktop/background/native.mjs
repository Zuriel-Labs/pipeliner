import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const exec = promisify(execFile);
export const backgroundBundleId = 'com.zuriellabs.pipeliner.desktop';
export const backgroundServiceName = backgroundBundleId + '.background.plist';
export function backgroundPlist(bundleId = backgroundBundleId) {
  if (!/^com\.zuriellabs\.pipeliner\.[A-Za-z0-9.-]{1,96}$/.test(bundleId)) throw new Error('Background bundle identity invalid');
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${bundleId}.background</string><key>BundleProgram</key><string>Contents/Library/LaunchServices/PipelinerBackground</string><key>ProgramArguments</key><array><string>PipelinerBackground</string></array><key>RunAtLoad</key><true/><key>LimitLoadToSessionType</key><string>Aqua</string></dict></plist>`;
}
export async function openMacBackgroundService(app) {
  const unavailable = Object.freeze({ inspect: () => ({ qualified: false, status: 'not-found' }), register() { throw new Error('Background package unavailable'); }, unregister() { throw new Error('Background package unavailable'); }, openSettings() { throw new Error('Background package unavailable'); } });
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !app.isPackaged) return unavailable;
  try {
    const bundle = dirname(dirname(dirname(process.execPath))), canonical = await realpath(bundle), info = await lstat(bundle);
    const trustedOwner = uid => uid === process.getuid() || uid === 0;
    if (canonical !== bundle || !info.isDirectory() || info.isSymbolicLink() || !trustedOwner(info.uid) || (info.mode & 0o022)) throw new Error();
    const helper = join(bundle, 'Contents/Library/LaunchServices/PipelinerBackground'), plist = join(bundle, 'Contents/Library/LaunchAgents', backgroundServiceName);
    for (const file of [helper, plist]) { const s = await lstat(file); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || !trustedOwner(s.uid) || (s.mode & 0o022) || await realpath(file) !== file) throw new Error(); }
    if (await readFile(plist, 'utf8') !== backgroundPlist()) throw new Error();
    const options = { timeout: 15000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' } };
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', '=anchor apple generic and identifier "' + backgroundBundleId + '"', bundle], options);
    const signature = await exec('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], options), helperSignature = await exec('/usr/bin/codesign', ['-dv', '--verbose=2', helper], options);
    const team = /TeamIdentifier=([A-Z0-9]{10})/.exec(signature.stderr)?.[1];
    if (!team || /TeamIdentifier=([A-Z0-9]{10})/.exec(helperSignature.stderr)?.[1] !== team) throw new Error();
    const settings = { type: 'agentService', serviceName: backgroundServiceName };
    return Object.freeze({ inspect() { return { qualified: true, status: app.getLoginItemSettings(settings).status }; },
      async register() { app.setLoginItemSettings({ ...settings, openAtLogin: true }); }, async unregister() { app.setLoginItemSettings({ ...settings, openAtLogin: false }); },
      async openSettings() { await exec(helper, ['--settings'], options); } });
  } catch { return unavailable; }
}
