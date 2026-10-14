import path from 'path';
import type { SitePermission } from '../shared';
import { JsonFile } from './store';

type Decision = 'allow' | 'block';

/** Granted silently, like Chrome. */
export const AUTO_ALLOW = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'keyboardLock']);
/** Asked through the infobar and remembered per site. */
export const ASKABLE = new Set([
  'media', 'geolocation', 'notifications', 'midiSysex', 'midi', 'clipboard-read', 'display-capture',
  'idle-detection', 'window-management', 'storage-access', 'top-level-storage-access', 'speaker-selection',
]);

const TEXT: Record<string, string> = {
  camera: 'use your camera',
  microphone: 'use your microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  midiSysex: 'use your MIDI devices',
  midi: 'use your MIDI devices',
  'clipboard-read': 'see text and images copied to the clipboard',
  'display-capture': 'share your screen',
  'idle-detection': 'know when you are actively using this device',
  'window-management': 'manage windows on all your displays',
  'storage-access': 'use cookies and data it saved while you were on other sites',
  'top-level-storage-access': 'use cookies and data it saved while you were on other sites',
  'speaker-selection': 'choose your audio output device',
};

/** "media" is stored as separate camera / microphone decisions. */
export function keysFor(permission: string, mediaTypes?: string[]) {
  if (permission !== 'media') return [permission];
  const keys = [];
  if (!mediaTypes || mediaTypes.includes('video')) keys.push('camera');
  if (!mediaTypes || mediaTypes.includes('audio')) keys.push('microphone');
  return keys.length ? keys : ['camera', 'microphone'];
}

export function describe(keys: string[]) {
  if (keys.includes('camera') && keys.includes('microphone')) return 'use your camera and microphone';
  return keys.map((k) => TEXT[k] || k).join(' and ');
}

export class Permissions {
  private file: JsonFile<{ sites: Record<string, Record<string, Decision>> }>;

  constructor(dataDir: string, persist = true) {
    this.file = new JsonFile(path.join(dataDir, 'permissions.json'), () => ({ sites: {} as Record<string, Record<string, Decision>> }), persist);
  }

  get(origin: string, key: string): Decision | undefined {
    return this.file.data.sites[origin]?.[key];
  }
  set(origin: string, keys: string[], decision: Decision) {
    const site = (this.file.data.sites[origin] ||= {});
    for (const k of keys) site[k] = decision;
    this.file.save();
  }
  list(): SitePermission[] {
    return Object.entries(this.file.data.sites)
      .filter(([, p]) => Object.keys(p).length)
      .map(([origin, permissions]) => ({ origin, permissions }))
      .sort((a, b) => a.origin.localeCompare(b.origin));
  }
  reset(origin: string, key?: string) {
    if (key) delete this.file.data.sites[origin]?.[key];
    else delete this.file.data.sites[origin];
    this.file.save();
  }
  flush() { this.file.flush(); }
}
