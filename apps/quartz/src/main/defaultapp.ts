// Registers Quartz with Windows as a PDF app (per user, no admin rights): it shows up in "Open with" for PDFs
// and in Settings > Apps > Default apps. Quartz lists itself whenever the installed launcher runs it; making
// it *the* default stays the user's choice (Windows only lets them make it, in Settings or "Open with").
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app, shell } from 'electron';
import type { Host } from './index';

const PROGID = 'Quartz.PDF';
const APP_KEY = 'Software\\Crystal Suite\\Quartz';
/** The launcher gives Quartz's windows this AppUserModelID; naming the handler with it keeps "Open with" from
 *  lumping Quartz together with other apps that Crystal Suite.exe starts. */
const AUMID = 'app.crystalsuite.quartz';
const HKCU = 'HKEY_CURRENT_USER';
const CLASSES = `HKCU\\Software\\Classes\\${PROGID}`;

function reg(args: string[]) {
  return new Promise<string | null>((resolve) => {
    execFile('reg', args, { windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}
const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function target(host: Host) {
  const { exe, args } = host.launchCommand();
  const command = `"${exe}"${args.map((a) => ` ${a.includes(' ') ? `"${a}"` : a}`).join('')} "%1"`;
  return { command, icon: `${host.ico || exe},0` };
}

/** Quartz's registration as a .reg file (HKCU only). */
export function regFile(host: Host) {
  const { command, icon } = target(host);
  const lines = ['Windows Registry Editor Version 5.00', ''];
  const key = (k: string, values: Record<string, string>) => {
    lines.push(`[${k}]`);
    for (const [n, v] of Object.entries(values)) lines.push(`${n === '@' ? '@' : `"${q(n)}"`}="${q(v)}"`);
    lines.push('');
  };
  const classes = `${HKCU}\\Software\\Classes\\${PROGID}`;
  key(classes, { '@': 'PDF Document', FriendlyTypeName: 'PDF Document' });
  key(`${classes}\\Application`, { ApplicationName: 'Quartz', ApplicationDescription: 'Read, fill, sign and edit PDFs.', ApplicationIcon: icon, ApplicationCompany: 'Crystal Suite', AppUserModelId: AUMID });
  key(`${classes}\\DefaultIcon`, { '@': icon });
  key(`${classes}\\shell\\open`, { FriendlyAppName: 'Quartz' });
  key(`${classes}\\shell\\open\\command`, { '@': command });
  key(`${HKCU}\\Software\\Classes\\.pdf\\OpenWithProgids`, { [PROGID]: '' });
  key(`${HKCU}\\${APP_KEY}\\Capabilities`, { ApplicationName: 'Quartz', ApplicationDescription: 'Read, fill, sign and edit PDFs.', ApplicationIcon: icon });
  key(`${HKCU}\\${APP_KEY}\\Capabilities\\FileAssociations`, { '.pdf': PROGID });
  key(`${HKCU}\\Software\\RegisteredApplications`, { Quartz: `${APP_KEY}\\Capabilities` });
  return lines.join('\r\n');
}

/** Tells Explorer that file associations changed, so "Open with" shows the change right away. */
function notifyShell() {
  const ps = 'Add-Type -Namespace Quartz -Name Shell -MemberDefinition \'[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);\'; [Quartz.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)';
  return new Promise<void>((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true }, () => resolve());
  });
}

async function writeKeys(host: Host) {
  const file = path.join(os.tmpdir(), `quartz-register-${process.pid}-${Date.now()}.reg`);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(regFile(host), 'utf16le')]));
  const out = await reg(['import', file]);
  fs.rmSync(file, { force: true });
  if (out !== null) await notifyShell();
  return out !== null;
}

/** Lists Quartz as a PDF app, or brings the listing up to date (each update moves Quartz's files). Only for
 *  the installed launcher: a development or test copy must never take over the installed one's entries. */
export async function ensureListed(host: Host) {
  if (process.platform !== 'win32' || host.standalone || !app.isPackaged) return;
  const { command, icon } = target(host);
  const [cmd, ico, aumid, listed, registered] = await Promise.all([
    reg(['query', `${CLASSES}\\shell\\open\\command`, '/ve']),
    reg(['query', `${CLASSES}\\DefaultIcon`, '/ve']),
    reg(['query', `${CLASSES}\\Application`, '/v', 'AppUserModelId']),
    reg(['query', 'HKCU\\Software\\Classes\\.pdf\\OpenWithProgids', '/v', PROGID]),
    reg(['query', 'HKCU\\Software\\RegisteredApplications', '/v', 'Quartz']),
  ]);
  if (cmd?.includes(command) && ico?.includes(icon) && aumid?.includes(AUMID) && listed && registered) return;
  await writeKeys(host);
}

/** Lists Quartz, then opens Settings on Quartz's default-apps page for the user to choose it. */
export async function register(host: Host) {
  if (process.platform !== 'win32') return false;
  if (!(await writeKeys(host))) return false;
  await shell.openExternal('ms-settings:defaultapps?registeredAppUser=Quartz').catch(() => shell.openExternal('ms-settings:defaultapps'));
  return true;
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
  await reg(['delete', CLASSES, '/f']);
  await notifyShell();
}
