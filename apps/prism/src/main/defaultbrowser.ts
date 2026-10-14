// Registers Prism with Windows as a browser (per user, no admin rights) so it can be picked as the
// default in Settings > Apps > Default apps. Windows only lets the user make that final choice.
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { shell } from 'electron';
import type { Host } from './prism';

const CLIENT = 'Software\\Clients\\StartMenuInternet\\Prism';
const HKCU = 'HKEY_CURRENT_USER';

function reg(args: string[]) {
  return new Promise<string>((resolve) => {
    execFile('reg', args, { windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}
const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export async function register(host: Host) {
  if (process.platform !== 'win32') return;
  const { exe, args } = host.launchCommand();
  const base = `"${exe}"${args.map((a) => ` ${a.includes(' ') ? `"${a}"` : a}`).join('')}`;
  const openCmd = `${base} "%1"`;
  const icon = `${host.ico || exe},0`;
  const lines = ['Windows Registry Editor Version 5.00', ''];
  const key = (k: string, values: Record<string, string>) => {
    lines.push(`[${k}]`);
    for (const [n, v] of Object.entries(values)) lines.push(`${n === '@' ? '@' : `"${q(n)}"`}="${q(v)}"`);
    lines.push('');
  };
  for (const [cls, label, isUrl] of [['PrismHTML', 'Prism HTML Document', false], ['PrismURL', 'Prism URL', true]] as const) {
    key(`${HKCU}\\Software\\Classes\\${cls}`, { '@': label, ...(isUrl ? { 'URL Protocol': '' } : {}) });
    key(`${HKCU}\\Software\\Classes\\${cls}\\DefaultIcon`, { '@': icon });
    key(`${HKCU}\\Software\\Classes\\${cls}\\shell\\open\\command`, { '@': openCmd });
  }
  key(`${HKCU}\\${CLIENT}`, { '@': 'Prism' });
  key(`${HKCU}\\${CLIENT}\\DefaultIcon`, { '@': icon });
  key(`${HKCU}\\${CLIENT}\\shell\\open\\command`, { '@': base });
  key(`${HKCU}\\${CLIENT}\\Capabilities`, {
    ApplicationName: 'Prism', ApplicationDescription: 'A clean, private web browser. No ads, no trackers, no account.', ApplicationIcon: icon,
  });
  key(`${HKCU}\\${CLIENT}\\Capabilities\\FileAssociations`, { '.htm': 'PrismHTML', '.html': 'PrismHTML', '.shtml': 'PrismHTML', '.xhtml': 'PrismHTML', '.pdf': 'PrismHTML' });
  key(`${HKCU}\\${CLIENT}\\Capabilities\\URLAssociations`, { http: 'PrismURL', https: 'PrismURL' });
  key(`${HKCU}\\${CLIENT}\\Capabilities\\StartMenu`, { StartMenuInternet: 'Prism' });
  key(`${HKCU}\\Software\\RegisteredApplications`, { Prism: `${CLIENT}\\Capabilities` });
  const file = path.join(os.tmpdir(), `prism-register-${process.pid}-${Date.now()}.reg`);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n'), 'utf16le')]));
  await reg(['import', file]);
  fs.rmSync(file, { force: true });
  await shell.openExternal('ms-settings:defaultapps?registeredAppUser=Prism').catch(() => shell.openExternal('ms-settings:defaultapps'));
}

export async function status() {
  if (process.platform !== 'win32') return { supported: false, registered: false, isDefault: false };
  const [choice, registered] = await Promise.all([
    reg(['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']),
    reg(['query', `HKCU\\Software\\RegisteredApplications`, '/v', 'Prism']),
  ]);
  return { supported: true, registered: /Prism/.test(registered), isDefault: /PrismURL/.test(choice) };
}

/** Removes the registration; with `onlyIf`, only when the registered command contains it. */
export async function unregister(onlyIf = '') {
  if (process.platform !== 'win32') return;
  if (onlyIf && !(await reg(['query', `HKCU\\${CLIENT}\\shell\\open\\command`, '/ve'])).includes(onlyIf)) return;
  await reg(['delete', 'HKCU\\Software\\RegisteredApplications', '/v', 'Prism', '/f']);
  for (const k of [`HKCU\\${CLIENT}`, 'HKCU\\Software\\Classes\\PrismHTML', 'HKCU\\Software\\Classes\\PrismURL']) await reg(['delete', k, '/f']);
}
