// Types and constants shared by Prism's main process, browser UI and internal pages.

export interface TabState {
  id: number;
  title: string;
  url: string;
  favicon: string;
  loading: boolean;
  audible: boolean;
  muted: boolean;
  crashed: boolean;
}

/** How the address bar describes the page's connection. */
export type Security = 'secure' | 'insecure' | 'internal' | 'file' | 'error' | 'cert-bypass' | 'none';

export interface PermissionPrompt {
  id: number;
  origin: string;
  text: string;
  /** "permission": Allow/Block (remembered); "external": Open/Cancel; "popup": Open it/dismiss. */
  kind: 'permission' | 'external' | 'popup';
}

export interface ActiveTabState {
  id: number;
  url: string;
  /** What the address bar shows when not editing (empty on the New Tab page). */
  displayUrl: string;
  security: Security;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  zoom: number; // percent
  blocked: number;
  shieldOn: boolean;
  shieldAvailable: boolean;
  bookmarked: boolean;
  find: { open: boolean; text: string; matches: number; current: number };
  prompt: PermissionPrompt | null;
  crashed: boolean;
}

export interface BookmarkItem {
  id: string;
  url: string;
  title: string;
  time: number;
  icon?: string;
}

export interface UIState {
  private: boolean;
  /** Name of the search engine, for the address bar placeholder. */
  engine: string;
  fullscreen: boolean;
  tabs: TabState[];
  active: ActiveTabState | null;
  downloads: { active: number; progress: number; unseen: boolean };
  /** null when the bookmarks bar is hidden */
  bookmarksBar: BookmarkItem[] | null;
}

export interface Suggestion {
  kind: 'search' | 'url' | 'history' | 'bookmark';
  title: string;
  sub: string;
  url: string;
  /** Text placed in the address bar while this row is highlighted. */
  fill: string;
}

export interface SuggestState {
  items: Suggestion[];
  selected: number;
}

export interface Visit {
  url: string;
  title: string;
  time: number;
}

export interface TopSite {
  url: string;
  title: string;
  host: string;
}

export interface DownloadRecord {
  id: string;
  url: string;
  filename: string;
  path: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  received: number;
  total: number;
  time: number;
  paused: boolean;
  exists?: boolean;
}

export interface Settings {
  searchEngine: string;
  startup: 'restore' | 'newtab';
  theme: 'system' | 'light' | 'dark';
  bookmarksBar: boolean;
  adblock: boolean;
  blockThirdPartyCookies: boolean;
  httpsUpgrade: boolean;
  doNotTrack: boolean;
  webrtcProtect: boolean;
  clearOnExit: boolean;
  downloadDir: string;
  askWhereToSave: boolean;
  hiddenTopSites: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  searchEngine: 'duckduckgo',
  startup: 'restore',
  theme: 'system',
  bookmarksBar: false,
  adblock: true,
  blockThirdPartyCookies: true,
  httpsUpgrade: true,
  doNotTrack: true,
  webrtcProtect: true,
  clearOnExit: false,
  downloadDir: '',
  askWhereToSave: false,
  hiddenTopSites: [],
};

export const ENGINES: Record<string, { name: string; url: string; home: string }> = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', home: 'https://duckduckgo.com/' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s', home: 'https://search.brave.com/' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s', home: 'https://www.startpage.com/' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s', home: 'https://www.ecosia.org/' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s', home: 'https://www.google.com/' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s', home: 'https://www.bing.com/' },
};

export const NEW_TAB_URL = 'prism://newtab/';
export const INTERNAL_PAGES = ['newtab', 'settings', 'history', 'downloads', 'bookmarks'];

export interface ClearDataOptions {
  history: boolean;
  cookies: boolean;
  cache: boolean;
  downloads: boolean;
}

export interface AboutInfo {
  version: string;
  chrome: string;
  electron: string;
  standalone: boolean;
  dataDir: string;
}

export interface AdblockInfo {
  enabled: boolean;
  ready: boolean;
  updatedAt: number;
  updating: boolean;
  error: string;
  allowlist: string[];
}

export interface SitePermission {
  origin: string;
  permissions: Record<string, 'allow' | 'block'>;
}
