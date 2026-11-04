// Registers Opal with Windows as a photo viewer (per user, no admin rights): it shows up in "Open with" for
// HEIC, JPEG, PNG and the other formats it opens, and in Settings > Apps > Default apps. Opal lists itself
// whenever the installed launcher runs it; making it *the* default stays the user's choice (Windows only lets
// them make it, in Settings or "Open with").
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app, shell } from 'electron';
import type { Host } from './index';

/** Extension -> the type name Explorer shows for files Opal opens by default. Matches app.json's fileTypes. */
const TYPES: Record<string, string> = {
  heic: 'HEIF Image', heif: 'HEIF Image', hif: 'HEIF Image', avif: 'AVIF Image',
  jpg: 'JPEG Image', jpeg: 'JPEG Image', jfif: 'JPEG Image', png: 'PNG Image', gif: 'GIF Image',
  webp: 'WebP Image', bmp: 'Bitmap Image', ico: 'Icon',
};
const progId = (ext: string) => `Opal.${ext}`;
const APP_KEY = 'Software\\Crystal Suite\\Opal';
/** The launcher gives Opal's windows this AppUserModelID; naming the handler with it keeps "Open with" from
 *  lumping Opal together with other apps that Crystal Suite.exe starts. */
const AUMID = 'app.crystalsuite.opal';
const HKCU = 'HKEY_CURRENT_USER';
const DESCRIPTION = 'View photos, including iPhone HEIC photos.';

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

/** Opal's registration as a .reg file (HKCU only). */
export function regFile(host: Host) {
  const { command, icon } = target(host);
  const lines = ['Windows Registry Editor Version 5.00', ''];
  const key = (k: string, values: Record<string, string>) => {
    lines.push(`[${k}]`);
    for (const [n, v] of Object.entries(values)) lines.push(`${n === '@' ? '@' : `"${q(n)}"`}="${q(v)}"`);
    lines.push('');
  };
  const assoc: Record<string, string> = {};
  for (const [ext, type] of Object.entries(TYPES)) {
    const classes = `${HKCU}\\Software\\Classes\\${progId(ext)}`;
    key(classes, { '@': type, FriendlyTypeName: type });
    key(`${classes}\\Application`, { ApplicationName: 'Opal', ApplicationDescription: DESCRIPTION, ApplicationIcon: icon, ApplicationCompany: 'Crystal Suite', AppUserModelId: AUMID });
    key(`${classes}\\DefaultIcon`, { '@': icon });
    key(`${classes}\\shell\\open`, { FriendlyAppName: 'Opal' });
    key(`${classes}\\shell\\open\\command`, { '@': command });
    key(`${HKCU}\\Software\\Classes\\.${ext}\\OpenWithProgids`, { [progId(ext)]: '' });
    assoc[`.${ext}`] = progId(ext);
  }
  key(`${HKCU}\\${APP_KEY}\\Capabilities`, { ApplicationName: 'Opal', ApplicationDescription: DESCRIPTION, ApplicationIcon: icon });
  key(`${HKCU}\\${APP_KEY}\\Capabilities\\FileAssociations`, assoc);
  key(`${HKCU}\\Software\\RegisteredApplications`, { Opal: `${APP_KEY}\\Capabilities` });
  return lines.join('\r\n');
}

/** Tells Explorer that file associations changed, so "Open with" shows the change right away. */
function notifyShell() {
  const ps = 'Add-Type -Namespace Opal -Name Shell -MemberDefinition \'[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);\'; [Opal.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)';
  return new Promise<void>((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true }, () => resolve());
  });
}

async function writeKeys(host: Host) {
  const file = path.join(os.tmpdir(), `opal-register-${process.pid}-${Date.now()}.reg`);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(regFile(host), 'utf16le')]));
  const out = await reg(['import', file]);
  fs.rmSync(file, { force: true });
  if (out !== null) await notifyShell();
  return out !== null;
}

/** Lists Opal as a photo viewer, or brings the listing up to date (each update moves Opal's files). Only for
 *  the installed launcher: a development or test copy must never take over the installed one's entries. */
export async function ensureListed(host: Host) {
  if (process.platform !== 'win32' || host.standalone || !app.isPackaged) return;
  const { command, icon } = target(host);
  const [cmd, ico, aumid, listed, registered] = await Promise.all([
    reg(['query', `HKCU\\Software\\Classes\\${progId('heic')}\\shell\\open\\command`, '/ve']),
    reg(['query', `HKCU\\Software\\Classes\\${progId('heic')}\\DefaultIcon`, '/ve']),
    reg(['query', `HKCU\\Software\\Classes\\${progId('heic')}\\Application`, '/v', 'AppUserModelId']),
    reg(['query', 'HKCU\\Software\\Classes\\.heic\\OpenWithProgids', '/v', progId('heic')]),
    reg(['query', 'HKCU\\Software\\RegisteredApplications', '/v', 'Opal']),
  ]);
  if (cmd?.includes(command) && ico?.includes(icon) && aumid?.includes(AUMID) && listed && registered) return;
  await writeKeys(host);
}

/** Lists Opal, then opens Settings on Opal's default-apps page for the user to choose it. */
export async function register(host: Host) {
  if (process.platform !== 'win32') return false;
  if (!(await writeKeys(host))) return false;
  await shell.openExternal('ms-settings:defaultapps?registeredAppUser=Opal').catch(() => shell.openExternal('ms-settings:defaultapps'));
  return true;
}

/** Whether Opal is listed, and whether it opens HEIC and JPEG photos by default. */
export async function status() {
  if (process.platform !== 'win32') return { supported: false, registered: false, isDefault: false };
  const choice = (ext: string) => reg(['query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.${ext}\\UserChoice`, '/v', 'ProgId']);
  const [heic, jpg, registered] = await Promise.all([choice('heic'), choice('jpg'), reg(['query', 'HKCU\\Software\\RegisteredApplications', '/v', 'Opal'])]);
  return { supported: true, registered: /Opal/.test(registered ?? ''), isDefault: (heic ?? '').includes(progId('heic')) && (jpg ?? '').includes(progId('jpg')) };
}

export async function unregister() {
  if (process.platform !== 'win32') return;
  await reg(['delete', 'HKCU\\Software\\RegisteredApplications', '/v', 'Opal', '/f']);
  await reg(['delete', `HKCU\\${APP_KEY}`, '/f']);
  for (const ext of Object.keys(TYPES)) {
    await reg(['delete', `HKCU\\Software\\Classes\\.${ext}\\OpenWithProgids`, '/v', progId(ext), '/f']);
    await reg(['delete', `HKCU\\Software\\Classes\\${progId(ext)}`, '/f']);
  }
  await notifyShell();
}
