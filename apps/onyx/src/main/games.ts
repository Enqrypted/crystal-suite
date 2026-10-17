// Telling games from other windows, for Onyx's "record games automatically" mode. A window counts as a game
// when you said so, when Windows itself knows it as a game (Game Bar's list), when a game launcher started it,
// when it runs from a game library folder or is a well-known game, when it was made with a game engine, or
// when it fills its screen (and isn't a browser, player or other everyday app).
import { execFile } from 'child_process';
import path from 'path';

/** A window as the helper describes it (sizes in physical pixels). */
export interface WindowInfo {
  hwnd: string;
  pid: number;
  exe: string;
  title: string;
  cls: string;
  fullscreen: boolean;
  minimized: boolean;
  w: number;
  h: number;
  monitor: string;
  mx: number;
  my: number;
  mw: number;
  mh: number;
  /** File name of the program that started it. */
  parent: string;
}

export interface GameRules {
  /** Program file names (lower case) that always / never count as games. */
  always: string[];
  never: string[];
  /** Full paths (lower case) of the games Windows knows (see windowsGames). */
  known?: Set<string>;
}

/** Game launchers: what they start is a game (Steam, Epic, Riot, Battle.net, EA, Ubisoft, GOG, Rockstar, …). */
const LAUNCHERS = new Set([
  'steam.exe', 'epicgameslauncher.exe', 'riotclientservices.exe', 'riotclientux.exe', 'battle.net.exe', 'eadesktop.exe',
  'origin.exe', 'ubisoftconnect.exe', 'upc.exe', 'galaxyclient.exe', 'rockstarlauncher.exe', 'amazongames.exe',
  'itch.exe', 'minecraftlauncher.exe', 'robloxplayerlauncher.exe', 'hoyoplay.exe', 'playnite.desktopapp.exe', 'playnite.fullscreenapp.exe',
]);

const LIBRARIES = [
  /\\steamapps\\common\\/i, /\\epic games\\/i, /\\riot games\\/i, /\\gog galaxy\\games\\/i, /\\gog games\\/i,
  /\\xboxgames\\/i, /\\ubisoft game launcher\\games\\/i, /\\ubisoft\\ubisoft connect\\games\\/i, /\\ea games\\/i,
  /\\origin games\\/i, /\\rockstar games\\/i, /\\battlestate games\\/i, /\\wizard101\\/i, /\\roblox\\versions\\/i,
  /\\hoyoplay\\games\\/i, /\\amazon games\\library\\/i, /\\itch\\apps\\/i, /^[a-z]:\\games\\/i,
];

const KNOWN = new Set([
  'robloxplayerbeta.exe', 'robloxstudiobeta.exe', 'minecraft.windows.exe', 'league of legends.exe', 'cs2.exe', 'csgo.exe',
  'dota2.exe', 'r5apex.exe', 'r5apex_dx12.exe', 'overwatch.exe', 'gta5.exe', 'gta5_enhanced.exe', 'rdr2.exe',
  'rocketleague.exe', 'cod.exe', 'eldenring.exe', 'cyberpunk2077.exe', 'rainbowsix.exe', 'rainbowsix_vulkan.exe',
  'destiny2.exe', 'tslgame.exe', 'hl2.exe', 'osu!.exe', 'terraria.exe', 'stardew valley.exe', 'warframe.x64.exe',
  'escapefromtarkov.exe', 'starfield.exe', 'witcher3.exe', 'bf2042.exe', 'brawlhalla.exe', 'genshinimpact.exe',
  'zenlesszonezero.exe', 'starrail.exe', 'deadlock.exe', 'valheim.exe', 'among us.exe', 'fallguys_client.exe',
  'palworld-win64-shipping.exe', 'helldivers2.exe', 'baldur\'s gate 3.exe', 'bg3.exe', 'bg3_dx11.exe', 'witcher3.exe',
  'forzahorizon5.exe', 'forzahorizon4.exe', 'hogwartslegacy.exe', 'diablo iv.exe', 'wow.exe', 'hearthstone.exe',
  'sc2_x64.exe', 'pathofexile.exe', 'pathofexile_x64.exe', 'pathofexile2.exe', 'lethal company.exe', 'phasmophobia.exe',
  'geometrydash.exe', 'hollow knight.exe', 'celeste.exe', 'cuphead.exe', 'factorio.exe', 'rust.exe', 'dayz_x64.exe',
  'arma3_x64.exe', 'thefinals.exe', 'cs2.exe', 'ffxiv_dx11.exe', 'eldenring.exe',
]);

/** Windows made by game engines (Unity, Unreal, SDL, GLFW, Source, CryEngine, Riot, Roblox). */
const ENGINE_CLASSES = new Set([
  'UnityWndClass', 'UnrealWindow', 'SDL_app', 'GLFW30', 'Valve001', 'CryENGINE', 'RiotWindowClass', 'WINDOWSCLIENT',
  'LaunchUnrealUWindowsClient', 'OgreD3D11Wnd', 'Engine', 'GameMaker', 'YYGameMakerYY',
]);

/** Everyday programs that go fullscreen (browsers, players, office apps) and Windows' own windows. */
const NOT_GAMES = new Set([
  'explorer.exe', 'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'opera_gx.exe', 'vivaldi.exe', 'arc.exe',
  'code.exe', 'devenv.exe', 'discord.exe', 'spotify.exe', 'steam.exe', 'steamwebhelper.exe', 'epicgameslauncher.exe',
  'riotclientux.exe', 'riotclientservices.exe', 'battle.net.exe', 'eadesktop.exe', 'galaxyclient.exe', 'ubisoftconnect.exe',
  'obs64.exe', 'vlc.exe', 'mpc-hc64.exe', 'mpc-be64.exe', 'potplayermini64.exe', 'wmplayer.exe', 'video.ui.exe', 'photos.exe',
  'microsoft.media.player.exe', 'powerpnt.exe', 'winword.exe', 'excel.exe', 'onenote.exe', 'outlook.exe', 'olk.exe', 'ms-teams.exe', 'teams.exe',
  'slack.exe', 'zoom.exe', 'electron.exe', 'crystal suite.exe', 'claude.exe', 'applicationframehost.exe', 'textinputhost.exe',
  'searchhost.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe', 'lockapp.exe', 'systemsettings.exe', 'taskmgr.exe',
  'mstsc.exe', 'vmware.exe', 'virtualboxvm.exe', 'unity.exe', 'unity hub.exe', 'unrealeditor.exe',
  'blender.exe', 'onyxhelper.exe', 'snippingtool.exe', 'screenclippinghost.exe', 'notepad.exe', 'wt.exe', 'windowsterminal.exe',
  'acrobat.exe', 'acrord32.exe', 'figma.exe', 'notion.exe', 'obsidian.exe', 'whatsapp.exe', 'telegram.exe', 'netflix.exe',
  // the launchers' own windows (they start these too)
  'epicwebhelper.exe', 'riotclientuxrender.exe', 'eacefsubprocess.exe', 'uplaywebcore.exe', 'galaxyclient helper.exe',
  'gog galaxy notifications renderer.exe', 'gameoverlayui.exe', 'steamerrorreporter.exe', 'crashreportclient.exe', 'unitycrashhandler64.exe',
]);

const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow', 'XamlExplorerHostIslandWindow']);

export const exeName = (exe: string) => path.win32.basename(exe || '').toLowerCase();

export function isGame(w: WindowInfo, rules: GameRules): boolean {
  const name = exeName(w.exe);
  if (!name || w.minimized) return false;
  if (rules.never.includes(name)) return false;
  if (rules.always.includes(name)) return true;
  if (NOT_GAMES.has(name) || SHELL_CLASSES.has(w.cls)) return false;
  if (w.w < 320 || w.h < 240) return false;
  if (rules.known?.has(w.exe.toLowerCase())) return true;
  if (LAUNCHERS.has((w.parent || '').toLowerCase())) return true;
  if (KNOWN.has(name) || /-win64-shipping\.exe$/.test(name) || /-wingdk-shipping\.exe$/.test(name)) return true;
  if (name === 'javaw.exe' && /minecraft/i.test(w.title)) return true;
  if (LIBRARIES.some((re) => re.test(w.exe))) return true;
  if (ENGINE_CLASSES.has(w.cls)) return true;
  return w.fullscreen;
}

/** A tidy name for the game: its library folder ("steamapps\common\<name>"), else the window title, else the program. */
export function gameName(w: Pick<WindowInfo, 'exe' | 'title'>): string {
  const lib = /\\(?:steamapps\\common|epic games|gog galaxy\\games|gog games|xboxgames|ubisoft game launcher\\games|ea games|origin games|rockstar games)\\([^\\]+)\\/i.exec(w.exe || '');
  let name = lib ? lib[1] : '';
  if (!name) name = (w.title || '').replace(/\s+[-–—|]\s+.*$/, '').trim();
  if (exeName(w.exe) === 'robloxplayerbeta.exe') name = 'Roblox';
  if (exeName(w.exe) === 'robloxstudiobeta.exe') {
    // "<place> - Roblox Studio"
    const place = (w.title || '').replace(/\s+[-–—]\s+Roblox Studio\s*$/i, '').trim();
    name = place && !/^Roblox Studio$/i.test(place) ? `Roblox Studio - ${place}` : 'Roblox Studio';
  }
  if (exeName(w.exe) === 'javaw.exe' && /minecraft/i.test(w.title)) name = 'Minecraft';
  if (!name) name = path.win32.basename(w.exe || 'Game', '.exe');
  return name.replace(/\s+/g, ' ').slice(0, 60);
}

/**
 * The games Windows knows (Game Bar keeps a list as you play: HKCU\System\GameConfigStore\Children, one key
 * per game with its program's full path). Read-only; an empty set where there is none.
 */
export function windowsGames(): Promise<Set<string>> {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\System\\GameConfigStore\\Children', '/s', '/v', 'MatchedExeFullPath'], { windowsHide: true, timeout: 8000, maxBuffer: 4 << 20 }, (err, stdout) => {
      const out = new Set<string>();
      if (!err) for (const m of String(stdout).matchAll(/MatchedExeFullPath\s+REG_SZ\s+(.+?)\s*$/gm)) out.add(m[1].trim().toLowerCase());
      resolve(out);
    });
  });
}

/** Safe as part of a file name. */
export function fileSafe(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/, '').trim() || 'Clip';
}
