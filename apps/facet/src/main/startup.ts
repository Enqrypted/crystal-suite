// Starting Facet when you sign in: a scheduled task (Windows holds programs in the Run key back for a
// while after sign-in; a sign-in task starts at once). Registered for this user only, without admin rights.
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

export function schtasks(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('schtasks', args, { windowsHide: true, timeout: 15000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') }));
  });
}

const xml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Creates (or updates) the task; true when it is in place. `tmpDir` holds the task definition briefly. */
export async function registerTask(name: string, exe: string, args: string, tmpDir: string): Promise<boolean> {
  // already right? (schtasks takes a moment, so the definition is only rewritten when it changes)
  const cur = await schtasks(['/query', '/tn', name, '/xml']);
  if (cur.ok && cur.out.includes(`<Command>${xml(exe)}</Command>`) && cur.out.includes(`<Arguments>${xml(args)}</Arguments>`)) return true;
  const user = xml(`${process.env.USERDOMAIN || ''}\\${process.env.USERNAME || ''}`);
  const def = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Starts Facet (Crystal Suite) when you sign in. Turn it off in Facet's settings.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(exe)}</Command><Arguments>${xml(args)}</Arguments></Exec></Actions>
</Task>`;
  const file = path.join(tmpDir, 'startup-task.xml');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(file, '﻿' + def, 'utf16le');
  const r = await schtasks(['/create', '/tn', name, '/xml', file, '/f']);
  try { fs.rmSync(file, { force: true }); } catch { /* temporary */ }
  return r.ok;
}

export async function deleteTask(name: string) {
  await schtasks(['/delete', '/tn', name, '/f']);
}
