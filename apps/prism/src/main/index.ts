// Entry point of Prism's main-process module (bundled to main.cjs). The host calls activate() once and
// then open(args) whenever the user starts Prism, clicks a link set to open in it, etc.
import { Prism, type Host } from './prism';
import * as defaultBrowser from './defaultbrowser';

export type { Host };

export function activate(host: Host) {
  const prism = new Prism(host);
  return {
    open: (args: string[] = []) => { prism.open(args).catch(() => {}); },
    windows: () => prism.windows.size,
    uninstall: () => prism.uninstall(),
    deactivate: () => prism.deactivate(),
  };
}

/** Called by the launcher before it deletes Prism: removes Prism's registration as a Windows browser
 *  (only the launcher's own registration, not the one of a separately installed Prism.exe). */
export async function uninstall() {
  await defaultBrowser.unregister('--open-app=prism');
}
