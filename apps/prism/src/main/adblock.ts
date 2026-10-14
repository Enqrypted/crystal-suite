// Ad & tracker blocking with Ghostery's engine and the EasyList / EasyPrivacy / uBlock Origin lists.
// Network requests are matched in the main process; element hiding and scriptlets are injected into
// pages on request from the tab preload. The lists are refreshed in the background every few days and
// parsed in a worker thread so the browser never stalls.
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';
import { net, type IpcMainInvokeEvent, type OnBeforeRequestListenerDetails, type OnHeadersReceivedListenerDetails } from 'electron';
import { FiltersEngine, Request, adsAndTrackingLists, fetchLists, fetchResources } from '@ghostery/adblocker';
import { parse } from 'tldts-experimental';
import { JsonFile } from './store';
import { hostOf } from './util';

const REFRESH_EVERY = 4 * 24 * 3600 * 1000;

type RequestType = Parameters<typeof Request.fromRawDetails>[0]['type'];

export interface DomFeatures { classes?: string[]; ids?: string[]; hrefs?: string[] }

export class AdBlock extends EventEmitter {
  engine: FiltersEngine | null = null;
  updating = false;
  error = '';
  private meta: JsonFile<{ updatedAt: number; allowlist: string[] }>;
  private counts = new Map<number, number>();

  constructor(private dataDir: string, private appDir: string, private enabled: () => boolean) {
    super();
    this.meta = new JsonFile(path.join(dataDir, 'adblock.json'), () => ({ updatedAt: 0, allowlist: [] as string[] }));
  }

  get updatedAt() { return this.meta.data.updatedAt; }
  get allowlist() { return this.meta.data.allowlist; }

  init() {
    const own = path.join(this.dataDir, 'adblock.bin');
    const bundled = path.join(this.appDir, 'adblock.bin');
    this.engine = this.load(own);
    if (!this.engine) {
      this.engine = this.load(bundled);
      if (this.engine) {
        try { this.meta.data.updatedAt = fs.statSync(bundled).mtimeMs; } catch { /* keep 0 */ }
      }
    }
    this.emit('change');
    if (!this.engine || Date.now() - this.updatedAt > REFRESH_EVERY) setTimeout(() => this.update().catch(() => {}), 15000);
  }

  private load(file: string) {
    try { return FiltersEngine.deserialize(new Uint8Array(fs.readFileSync(file))); } catch { return null; }
  }

  /** Downloads the latest lists and rebuilds the engine off the main thread. */
  async update() {
    if (this.updating) return;
    this.updating = true;
    this.error = '';
    this.emit('change');
    try {
      const fetchImpl = ((url: string) => net.fetch(url, { cache: 'no-store' })) as unknown as Parameters<typeof fetchLists>[0];
      const [lists, resources] = await Promise.all([fetchLists(fetchImpl, adsAndTrackingLists), fetchResources(fetchImpl)]);
      const bin = await this.buildInWorker(lists, resources);
      const engine = FiltersEngine.deserialize(bin);
      fs.mkdirSync(this.dataDir, { recursive: true });
      const file = path.join(this.dataDir, 'adblock.bin');
      fs.writeFileSync(file + '.tmp', bin);
      fs.renameSync(file + '.tmp', file);
      this.engine = engine;
      this.meta.data.updatedAt = Date.now();
      this.meta.save(0);
    } catch {
      this.error = "The filter lists couldn't be updated. Prism will try again later.";
    } finally {
      this.updating = false;
      this.emit('change');
    }
  }

  private buildInWorker(lists: string[], resources: string): Promise<Uint8Array> {
    const code = fs.readFileSync(path.join(this.appDir, 'adblock-worker.cjs'), 'utf8');
    return new Promise((resolve, reject) => {
      const w = new Worker(code, { eval: true, workerData: { lists, resources } });
      w.once('message', (bin: Uint8Array) => { resolve(bin); w.terminate(); });
      w.once('error', reject);
      w.once('exit', (c) => { if (c !== 0 && c !== 1) reject(new Error(`worker exited ${c}`)); });
    });
  }

  // ---------- per-site switch ----------
  private siteKey(url: string) { return hostOf(url).replace(/^www\./, ''); }
  isAllowlisted(url: string) {
    const h = this.siteKey(url);
    return !!h && this.allowlist.includes(h);
  }
  setAllowlisted(url: string, allowed: boolean) {
    const h = this.siteKey(url);
    if (!h) return;
    const list = this.allowlist.filter((x) => x !== h);
    if (allowed) list.push(h);
    this.meta.data.allowlist = list.sort();
    this.meta.save(0);
    this.emit('change');
  }
  removeAllow(host: string) {
    this.meta.data.allowlist = this.allowlist.filter((x) => x !== host);
    this.meta.save(0);
    this.emit('change');
  }
  /** Whether protections apply on a page (setting on, engine ready, site not switched off). */
  activeOn(pageUrl: string) {
    return this.enabled() && !!this.engine && /^https?:/i.test(pageUrl) && !this.isAllowlisted(pageUrl);
  }

  // ---------- counts per tab ----------
  blocked(wcId: number) { return this.counts.get(wcId) || 0; }
  resetCount(wcId: number) { if (this.counts.delete(wcId)) this.emit('blocked', wcId); }
  private bump(wcId: number | undefined) {
    if (wcId === undefined) return;
    this.counts.set(wcId, (this.counts.get(wcId) || 0) + 1);
    this.emit('blocked', wcId);
  }

  // ---------- network ----------
  private request(details: { id: number; url: string; referrer?: string; resourceType?: string; webContentsId?: number }, page: string) {
    const req = Request.fromRawDetails({
      requestId: String(details.id), url: details.url, sourceUrl: details.referrer || page,
      type: (details.resourceType || 'other') as RequestType, tabId: details.webContentsId,
    });
    if (req.type === 'other') req.guessTypeOfRequest();
    return req;
  }

  /** Decision for one request: cancel it, redirect it to a harmless stand-in, or let it through. */
  match(details: OnBeforeRequestListenerDetails, pageUrl: string): { cancel?: boolean; redirectURL?: string } | null {
    if (details.resourceType === 'mainFrame' || !this.activeOn(pageUrl)) return null;
    const { match, redirect } = this.engine!.match(this.request(details, pageUrl));
    if (redirect) { this.bump(details.webContentsId); return { redirectURL: redirect.dataUrl }; }
    if (match) { this.bump(details.webContentsId); return { cancel: true }; }
    return null;
  }

  /** Extra Content-Security-Policy some filters add to documents. */
  csp(details: OnHeadersReceivedListenerDetails, pageUrl: string) {
    if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') return undefined;
    const page = details.resourceType === 'mainFrame' ? details.url : pageUrl;
    if (!this.activeOn(page)) return undefined;
    return this.engine!.getCSPDirectives(this.request(details, page));
  }

  // ---------- cosmetic filtering (called by the tab preload) ----------
  cosmetics = async (e: IpcMainInvokeEvent, url: string, features?: DomFeatures) => {
    if (typeof url !== 'string' || !this.activeOn(url)) return;
    const { hostname, domain } = parse(url);
    const first = features === undefined;
    const { active, styles, scripts } = this.engine!.getCosmeticsFilters({
      url, hostname: hostname || '', domain: domain || '',
      classes: features?.classes, hrefs: features?.hrefs, ids: features?.ids,
      getBaseRules: first, getInjectionRules: first, getExtendedRules: false,
      getRulesFromHostname: first, getRulesFromDOM: !first,
    });
    if (!active) return;
    if (styles.length) e.sender.insertCSS(styles, { cssOrigin: 'user' }).catch(() => {});
    for (const s of scripts) e.sender.executeJavaScript(s, true).catch(() => {});
  };

  flush() { this.meta.flush(); }
}
