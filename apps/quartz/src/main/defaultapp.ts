// Registers Quartz with Windows as a PDF app (per user, no admin rights), so it shows up in "Open with" and
// can be picked in Settings > Apps > Default apps. Windows only lets the user make that final choice.
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { shell } from 'electron';
import type { Host } from './index';

const PROGID = 'Quartz.PDF';
const APP_KEY = 'Software\\Crystal Suite\\Quartz';
const HKCU = 'HKEY_CURRENT_USER';

function reg(args: string[]) {
  return new Promise<string | null>((resolve) => {
    execFile('reg', args, { windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}
const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Writes Quartz's registration (per user). */
async function writeKeys(host: Host) {
  const { exe, args } = host.launchCommand();
  const base = `"${exe}"${args.map((a) => ` ${a.includes(' ') ? `"${a}"` : a}`).join('')}`;
  const icon = `${host.ico || exe},0`;
  const lines = ['Windows Registry Editor Version 5.00', ''];
  const key = (k: string, values: Record<string, string>) => {
    lines.push(`[${k}]`);
    for (const [n, v] of Object.entries(values)) lines.push(`${n === '@' ? '@' : `"${q(n)}"`}="${q(v)}"`);
    lines.push('');
  };
  key(`${HKCU}\\Software\\Classes\\${PROGID}`, { '@': 'PDF Document (Quartz)', FriendlyTypeName: 'PDF Document' });
  key(`${HKCU}\\Software\\Classes\\${PROGID}\\DefaultIcon`, { '@': icon });
  key(`${HKCU}\\Software\\Classes\\${PROGID}\\shell\\open\\command`, { '@': `${base} "%1"` });
  key(`${HKCU}\\Software\\Classes\\.pdf\\OpenWithProgids`, { [PROGID]: '' });
  key(`${HKCU}\\${APP_KEY}\\Capabilities`, { ApplicationName: 'Quartz', ApplicationDescription: 'Read, fill, sign and edit PDFs.', ApplicationIcon: icon });
  key(`${HKCU}\\${APP_KEY}\\Capabilities\\FileAssociations`, { '.pdf': PROGID });
  key(`${HKCU}\\Software\\RegisteredApplications`, { Quartz: `${APP_KEY}\\Capabilities` });
  const file = path.join(os.tmpdir(), `quartz-register-${process.pid}-${Date.now()}.reg`);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n'), 'utf16le')]));
  const out = await reg(['import', file]);
  fs.rmSync(file, { force: true });
  return out !== null;
}

/** Registers Quartz, then opens Settings on Quartz's default-apps page for the user to choose it. */
export async function register(host: Host) {
  if (process.platform !== 'win32') return false;
  if (!(await writeKeys(host))) return false;
  await shell.openExternal('ms-settings:defaultapps?registeredAppUser=Quartz').catch(() => shell.openExternal('ms-settings:defaultapps'));
  return true;
}

/** Rewrites the registration if Quartz is registered: its files move to a new folder with each update. */
export async function refresh(host: Host) {
  // the dev host must never take over the installed Quartz's registration
  if (process.platform !== 'win32' || host.standalone) return;
  const s = await status();
  if (s.registered) await writeKeys(host);
}

export async function status() {
  if (process.platform !== 'win32') return { supported: false, registered: false, isDefault: false };
  const [choice, registered] = await Promise.all([
    reg(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice', '/v', 'ProgId']),
    reg(['query', 'HKCU\\Software\\RegisteredApplications', '/v', 'Quartz']),
  ]);
  return { supported: true, registered: /Quartz/.test(registered ?? ''), isDefault: (choice ?? '').includes(PROGID) };
}

export async function unregister() {
  if (process.platform !== 'win32') return;
  await reg(['delete', 'HKCU\\Software\\RegisteredApplications', '/v', 'Quartz', '/f']);
  await reg(['delete', `HKCU\\${APP_KEY}`, '/f']);
  await reg(['delete', 'HKCU\\Software\\Classes\\.pdf\\OpenWithProgids', '/v', PROGID, '/f']);
  await reg(['delete', `HKCU\\Software\\Classes\\${PROGID}`, '/f']);
}
