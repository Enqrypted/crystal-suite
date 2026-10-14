// A browsing profile = one Electron session with Prism's privacy defaults: a clean Chrome user agent,
// HTTPS upgrades, Do Not Track / Global Privacy Control, third-party cookie blocking, ad & tracker
// blocking, permission prompts and downloads. Private windows share one in-memory profile.
import { app, session, type DownloadItem, type Event, type Session, type WebContents } from 'electron';
import type { Prism } from './prism';
import { Permissions, AUTO_ALLOW, ASKABLE, keysFor, describe } from './permissions';
import { hostOf, isLocalHost, isThirdParty, originOf } from './util';

/** Chrome's own (reduced) user agent, without the Electron and app tokens some sites reject. */
export function userAgent() {
  const major = process.versions.chrome.split('.')[0];
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

let privateCounter = 0;

export class Profile {
  readonly ses: Session;
  readonly permissions: Permissions;
  /** The http:// URL a tab asked for before Prism upgraded it, so a failed upgrade can fall back. */
  readonly upgraded = new Map<number, string>();
  /** Hosts that turned out not to support HTTPS this session. */
  readonly httpAllowed = new Set<string>();
  /** Hosts the user chose to open despite a certificate error (this session only). */
  readonly certBypass = new Set<string>();

  constructor(private prism: Prism, readonly isPrivate: boolean) {
    this.ses = isPrivate ? session.fromPartition(`prism-private-${++privateCounter}`, { cache: false }) : session.fromPartition('persist:prism');
    this.permissions = isPrivate ? new Permissions('', false) : prism.permissions;
    this.setup();
  }

  private topUrl(details: { webContents?: WebContents; resourceType?: string; url: string }) {
    if (details.resourceType === 'mainFrame') return details.url;
    const wc = details.webContents;
    try { return wc && !wc.isDestroyed() ? wc.getURL() : ''; } catch { return ''; }
  }

  private onDownload = (_e: Event, item: DownloadItem) => {
    this.prism.downloads.handle(item, { dir: this.prism.downloadDir(), ask: this.prism.consumeAsk(), isPrivate: this.isPrivate });
  };

  private setup() {
    const { ses, prism } = this;
    ses.setUserAgent(userAgent(), app.getPreferredSystemLanguages().join(',') || 'en-US,en');
    ses.setSpellCheckerEnabled(true);
    if (ses.protocol.isProtocolHandled('prism')) ses.protocol.unhandle('prism');
    ses.protocol.handle('prism', (req) => prism.servePage(req));

    ses.webRequest.onBeforeRequest((details, cb) => {
      if (prism.settings.httpsUpgrade && details.resourceType === 'mainFrame' && details.method === 'GET' && details.url.startsWith('http://')) {
        const host = hostOf(details.url);
        if (host && !isLocalHost(host) && !this.httpAllowed.has(host)) {
          if (details.webContentsId !== undefined) this.upgraded.set(details.webContentsId, details.url);
          cb({ redirectURL: 'https://' + details.url.slice(7) });
          return;
        }
      }
      cb(prism.adblock.match(details, this.topUrl(details)) || {});
    });

    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = details.requestHeaders;
      if (prism.settings.doNotTrack) { h.DNT = '1'; h['Sec-GPC'] = '1'; }
      if (prism.settings.blockThirdPartyCookies && details.resourceType !== 'mainFrame') {
        const top = this.topUrl(details);
        if (top && isThirdParty(details.url, top) && !prism.adblock.isAllowlisted(top)) {
          for (const k of Object.keys(h)) if (k.toLowerCase() === 'cookie') delete h[k];
        }
      }
      cb({ requestHeaders: h });
    });

    ses.webRequest.onHeadersReceived((details, cb) => {
      const headers = details.responseHeaders;
      if (!headers) { cb({}); return; }
      let changed = false;
      const top = this.topUrl(details);
      if (prism.settings.blockThirdPartyCookies && details.resourceType !== 'mainFrame' && top && isThirdParty(details.url, top) && !prism.adblock.isAllowlisted(top)) {
        for (const k of Object.keys(headers)) if (k.toLowerCase() === 'set-cookie') { delete headers[k]; changed = true; }
      }
      const csp = prism.adblock.csp(details, top);
      if (csp) {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-security-policy') || 'Content-Security-Policy';
        headers[key] = [...(headers[key] || []), csp];
        changed = true;
      }
      cb(changed ? { responseHeaders: headers } : {});
    });

    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (AUTO_ALLOW.has(permission)) { callback(true); return; }
      if (permission === 'openExternal') { prism.askExternal(wc, (details as { externalURL?: string }).externalURL || '', details.requestingUrl, callback); return; }
      if (!ASKABLE.has(permission)) { callback(false); return; }
      const origin = originOf(details.requestingUrl || wc.getURL());
      if (!/^https?:/.test(origin)) { callback(false); return; }
      const keys = keysFor(permission, (details as { mediaTypes?: string[] }).mediaTypes);
      const saved = keys.map((k) => this.permissions.get(origin, k));
      if (saved.every((d) => d === 'allow')) { callback(true); return; }
      if (saved.some((d) => d === 'block')) { callback(false); return; }
      prism.askPermission(wc, origin, describe(keys), (allow, remember) => {
        if (remember) this.permissions.set(origin, keys, allow ? 'allow' : 'block');
        callback(allow);
      });
    });

    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
      if (AUTO_ALLOW.has(permission)) return true;
      const origin = originOf(requestingOrigin) || requestingOrigin;
      const media = (details as { mediaType?: string }).mediaType;
      const keys = permission === 'media' ? keysFor('media', media && media !== 'unknown' ? [media] : undefined) : [permission];
      return keys.every((k) => this.permissions.get(origin, k) === 'allow');
    });

    ses.on('will-download', this.onDownload);
  }

  /** Detaches every handler (used before a newer Prism version takes over the session, and for private profiles). */
  dispose() {
    const { ses } = this;
    ses.webRequest.onBeforeRequest(null);
    ses.webRequest.onBeforeSendHeaders(null);
    ses.webRequest.onHeadersReceived(null);
    ses.setPermissionRequestHandler(null);
    ses.setPermissionCheckHandler(null);
    ses.removeListener('will-download', this.onDownload);
    if (ses.protocol.isProtocolHandled('prism')) ses.protocol.unhandle('prism');
    if (this.isPrivate) {
      ses.clearStorageData().catch(() => {});
      ses.clearCache().catch(() => {});
    }
  }
}
