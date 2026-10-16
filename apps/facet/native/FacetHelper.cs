// Facet's Windows helper. Keeps the widget layer on the desktop (owned by the shell's desktop window,
// directly above it, never minimized by "Show desktop"), extracts large shell icons and thumbnails,
// reports the wallpaper, toggles the Windows desktop icons (and shows them again whenever Facet stops) and
// reports drags that start on the empty desktop (for Facet's selection box while the icons are hidden).
//
// Protocol (UTF-8 lines on stdin/stdout, tab-separated):
//   request  "<id>\t<command>\t<arg>..."     reply  "<id>\tok\t<result>" or "<id>\terr\t<message>"
//   event    "0\tevent\t<name>\t<data>"
// The helper exits when stdin closes (Facet quit or crashed).
//
// Built with the C# compiler that ships with Windows (.NET Framework 4.x), so C# 5 syntax only.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Program
{
    public const string Version = "2";
    static TextWriter stdout;
    static readonly BlockingCollection<string> outbox = new BlockingCollection<string>();

    /// <summary>Queues a line for Facet; a writer thread sends it (callers, such as the mouse hook, never wait).</summary>
    public static void Send(string line) { outbox.Add(line); }
    public static void Event(string name, string data) { Send("0\tevent\t" + name + "\t" + (data ?? "")); }

    [STAThread]
    static int Main(string[] args)
    {
        // physical pixels everywhere (monitor rects for the wallpaper match Electron's at any scaling)
        try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        if (args.Length > 0 && args[0] == "show-icons") { Shell.SetIconsVisible(true); return 0; }
        if (args.Length > 0 && args[0] == "hide-icons") { Shell.SetIconsVisible(false); return 0; }
        int pid = 0;
        for (int i = 0; i + 1 < args.Length; i++) if (args[i] == "--pid") int.TryParse(args[i + 1], out pid);

        stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        var writer = new Thread(delegate ()
        {
            foreach (var line in outbox.GetConsumingEnumerable()) { try { stdout.Write(line + "\n"); stdout.Flush(); } catch { } }
        });
        writer.IsBackground = true;
        writer.Start();
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        var host = new Host(pid);
        var icons = new IconWorker();
        var reader = new Thread(delegate ()
        {
            string line;
            try { while ((line = stdin.ReadLine()) != null) Dispatch(line, host, icons); } catch { }
            // Facet quit, was updated or crashed: put back the desktop icons it hid, then go
            host.Post(delegate { host.Closing(); Application.ExitThread(); });
        });
        reader.IsBackground = true;
        reader.Start();
        Event("ready", Version);
        Application.Run();
        DragWatcher.Stop();
        host.Unpin();
        return 0;
    }

    static void Dispatch(string line, Host host, IconWorker icons)
    {
        string[] a = line.Split('\t');
        if (a.Length < 2) return;
        string id = a[0], cmd = a[1];
        try
        {
            switch (cmd)
            {
                case "hello": Send(id + "\tok\t" + Version); break;
                case "pin": { IntPtr h = ParseHwnd(a[2]); host.Post(delegate { host.Pin(h); Send(id + "\tok\t"); }); break; }
                case "unpin": { IntPtr h = ParseHwnd(a[2]); host.Post(delegate { host.Unpin(h); Send(id + "\tok\t"); }); break; }
                case "place": host.Post(delegate { host.PlaceAll(); Send(id + "\tok\t"); }); break;
                case "icon": icons.Enqueue(id, a[2], int.Parse(a[3]), a[4]); break;
                case "wallpaper": Send(id + "\tok\t" + Wallpaper.Describe()); break;
                case "icons-visible": Send(id + "\tok\t" + (Shell.IconsVisible() ? "1" : "0")); break;
                case "set-icons": host.Post(delegate { host.SetIcons(a[2] == "1"); Send(id + "\tok\t" + (Shell.IconsVisible() ? "1" : "0")); }); break;
                case "logoff-keep": host.KeepHiddenAtLogoff = a[2] == "1"; Send(id + "\tok\t"); break;
                case "drag-watch": host.Post(delegate { if (a[2] == "1") DragWatcher.Start(host); else DragWatcher.Stop(); Send(id + "\tok\t"); }); break;
                default: Send(id + "\terr\tunknown command " + cmd); break;
            }
        }
        catch (Exception e) { Send(id + "\terr\t" + OneLine(e.Message)); }
    }

    public static IntPtr ParseHwnd(string s) { return new IntPtr(long.Parse(s)); }
    public static string OneLine(string s) { return (s ?? "").Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' '); }
}

/// <summary>Hidden top-level window on the UI thread: receives broadcasts (wallpaper changes, Explorer
/// restarts), hosts the WinEvent hooks and keeps the pinned windows at desktop level.</summary>
class Host : NativeWindow
{
    const int WM_APP_RUN = 0x8001;
    const int WM_SETTINGCHANGE = 0x001A;
    const int SPI_SETDESKWALLPAPER = 0x0014;
    readonly int taskbarCreated = Native.RegisterWindowMessage("TaskbarCreated");
    readonly ConcurrentQueue<Action> queue = new ConcurrentQueue<Action>();
    readonly List<IntPtr> pinned = new List<IntPtr>();
    readonly Native.WinEventProc onForeground, onMinimize;
    readonly System.Windows.Forms.Timer check = new System.Windows.Forms.Timer();
    bool desktopShown;
    /// <summary>Facet hid the desktop icons: they come back when it stops.</summary>
    bool hidIcons;
    volatile bool sessionEnding;
    /// <summary>At sign-out, leave them hidden (Facet starts with Windows and hides them again).</summary>
    public volatile bool KeepHiddenAtLogoff;

    public void SetIcons(bool show)
    {
        Shell.SetIconsVisible(show);
        hidIcons = !show;
    }

    /// <summary>Facet is going away (or Windows is signing out): show the icons Facet hid.</summary>
    public void Closing()
    {
        if (!hidIcons || (sessionEnding && KeepHiddenAtLogoff)) return;
        Shell.SetIconsVisible(true);
        hidIcons = false;
    }

    public IntPtr[] Pinned() { return pinned.ToArray(); }

    public Host(int pid)
    {
        CreateHandle(new CreateParams { Caption = "Facet helper" });
        onForeground = Foreground;
        onMinimize = Minimized;
        Native.SetWinEventHook(Native.EVENT_SYSTEM_FOREGROUND, Native.EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, onForeground, 0, 0, Native.WINEVENT_OUTOFCONTEXT);
        if (pid > 0) Native.SetWinEventHook(Native.EVENT_SYSTEM_MINIMIZESTART, Native.EVENT_SYSTEM_MINIMIZESTART, IntPtr.Zero, onMinimize, (uint)pid, 0, Native.WINEVENT_OUTOFCONTEXT);
        check.Interval = 150;
        check.Tick += delegate { Validate(); };
        check.Start();
    }

    public void Post(Action a) { queue.Enqueue(a); Native.PostMessage(Handle, WM_APP_RUN, IntPtr.Zero, IntPtr.Zero); }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_APP_RUN)
        {
            Action a;
            while (queue.TryDequeue(out a)) { try { a(); } catch (Exception e) { Program.Event("error", Program.OneLine(e.Message)); } }
            return;
        }
        if (m.Msg == WM_SETTINGCHANGE && m.WParam.ToInt64() == SPI_SETDESKWALLPAPER) Program.Event("wallpaper", "");
        if (m.Msg == 0x0011) { sessionEnding = true; m.Result = new IntPtr(1); return; } // WM_QUERYENDSESSION
        if (m.Msg == 0x0016) // WM_ENDSESSION
        {
            if (m.WParam != IntPtr.Zero)
            {
                if (hidIcons && !KeepHiddenAtLogoff)
                {
                    Shell.SetIconsVisible(true);
                    Shell.WriteHideIcons(false); // in case Explorer is already gone
                    hidIcons = false;
                }
            }
            else sessionEnding = false; // sign-out cancelled
            m.Result = IntPtr.Zero;
            return;
        }
        if (m.Msg == taskbarCreated)
        {
            // Explorer restarted: the desktop window is new, re-own and re-place everything shortly
            var t = new System.Windows.Forms.Timer { Interval = 1500 };
            t.Tick += delegate { t.Stop(); t.Dispose(); PlaceAll(); Program.Event("explorer", ""); };
            t.Start();
        }
        base.WndProc(ref m);
    }

    public void Pin(IntPtr h)
    {
        if (!pinned.Contains(h)) pinned.Add(h);
        DragWatcher.Ours(pinned.ToArray());
        Place(h);
    }
    public void Unpin(IntPtr h)
    {
        pinned.Remove(h);
        if (Native.IsWindow(h)) Native.SetWindowLongPtr(h, Native.GWLP_HWNDPARENT, IntPtr.Zero);
    }
    public void Unpin() { foreach (var h in pinned.ToArray()) Unpin(h); }

    public void PlaceAll() { foreach (var h in pinned.ToArray()) Place(h); }

    /// <summary>Owns the window by the desktop and puts it directly above it in the z-order.</summary>
    void Place(IntPtr h)
    {
        if (!Native.IsWindow(h)) { pinned.Remove(h); return; }
        IntPtr desk = Shell.DesktopWindow();
        if (desk == IntPtr.Zero) return;
        if (Native.GetWindowLongPtr(h, Native.GWLP_HWNDPARENT) != desk) Native.SetWindowLongPtr(h, Native.GWLP_HWNDPARENT, desk);
        if (Native.IsIconic(h)) Native.ShowWindow(h, Native.SW_SHOWNOACTIVATE);
        // already right above the desktop, possibly with other pinned windows in between?
        IntPtr w = Native.GetWindow(desk, Native.GW_HWNDPREV);
        while (w != IntPtr.Zero && pinned.Contains(w) && w != h) w = Native.GetWindow(w, Native.GW_HWNDPREV);
        if (w == h) return;
        IntPtr above = Native.GetWindow(desk, Native.GW_HWNDPREV);
        Native.SetWindowPos(h, above == IntPtr.Zero ? Native.HWND_TOP : above, 0, 0, 0, 0,
            Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE | Native.SWP_NOOWNERZORDER);
    }

    int ticks;
    IntPtr desk;

    /// <summary>Runs every 150 ms: when the shell drops the desktop back down after "Show desktop", owned
    /// windows stay where they were (above the apps) - put them back right above the desktop.</summary>
    void Validate()
    {
        if (pinned.Count == 0) return;
        if (desk == IntPtr.Zero || !Native.IsWindow(desk) || ++ticks % 20 == 0) desk = Shell.DesktopWindow();
        foreach (var h in pinned.ToArray())
        {
            if (!Native.IsWindow(h)) { pinned.Remove(h); continue; }
            if (desk != IntPtr.Zero && Native.GetWindowLongPtr(h, Native.GWLP_HWNDPARENT) != desk) { Place(h); continue; }
            if (Native.IsIconic(h)) { Place(h); continue; }
            IntPtr w = Native.GetWindow(desk, Native.GW_HWNDPREV);
            while (w != IntPtr.Zero && w != h && pinned.Contains(w)) w = Native.GetWindow(w, Native.GW_HWNDPREV);
            if (w != h) Place(h);
        }
    }

    void Foreground(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        bool desktop = Shell.IsDesktop(hwnd);
        if (desktop)
        {
            // "Show desktop" (Win+D) or a click on the desktop: make sure the widgets are there
            foreach (var h in pinned.ToArray()) if (Native.IsWindow(h) && Native.IsIconic(h)) Native.ShowWindow(h, Native.SW_SHOWNOACTIVATE);
            PlaceAll();
        }
        else if (pinned.Contains(hwnd))
        {
            // one of ours was activated (e.g. to type a folder name): keep it at desktop level
            Place(hwnd);
        }
        if (desktop != desktopShown) { desktopShown = desktop; Program.Event("desktop", desktop ? "1" : "0"); }
    }

    void Minimized(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        if (idObject != 0 || !pinned.Contains(hwnd)) return;
        IntPtr h = hwnd;
        Post(delegate { if (Native.IsWindow(h) && Native.IsIconic(h)) { Native.ShowWindow(h, Native.SW_SHOWNOACTIVATE); Place(h); } });
    }
}

static class Shell
{
    static string ClassOf(IntPtr h)
    {
        var s = new StringBuilder(64);
        Native.GetClassName(h, s, s.Capacity);
        return s.ToString();
    }

    /// <summary>The top-level window that holds the desktop icons (Progman, or a WorkerW on older Windows).</summary>
    public static IntPtr DesktopWindow()
    {
        IntPtr progman = Native.FindWindow("Progman", null);
        if (progman != IntPtr.Zero && Native.FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) return progman;
        IntPtr found = IntPtr.Zero;
        Native.EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (ClassOf(h) == "WorkerW" && Native.FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found != IntPtr.Zero ? found : progman;
    }

    public static IntPtr DefView()
    {
        IntPtr d = DesktopWindow();
        return d == IntPtr.Zero ? IntPtr.Zero : Native.FindWindowEx(d, IntPtr.Zero, "SHELLDLL_DefView", null);
    }

    public static bool IsDesktop(IntPtr h)
    {
        if (h == IntPtr.Zero) return false;
        string c = ClassOf(h);
        if (c != "Progman" && c != "WorkerW") return false;
        return h == DesktopWindow() || Native.FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero || c == "WorkerW";
    }

    public static bool IconsVisible()
    {
        IntPtr lv = Native.FindWindowEx(DefView(), IntPtr.Zero, "SysListView32", null);
        return lv != IntPtr.Zero && Native.IsWindowVisible(lv);
    }

    /// <summary>Explorer's own setting behind View > Show desktop icons.</summary>
    public static void WriteHideIcons(bool hide)
    {
        try { Microsoft.Win32.Registry.SetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "HideIcons", hide ? 1 : 0, Microsoft.Win32.RegistryValueKind.DWord); } catch { }
    }

    /// <summary>Same as the desktop's View > Show desktop icons (remembered by Windows).</summary>
    public static void SetIconsVisible(bool show)
    {
        if (IconsVisible() == show) return;
        IntPtr dv = DefView();
        if (dv == IntPtr.Zero) return;
        Native.SendMessage(dv, 0x0111 /* WM_COMMAND */, new IntPtr(0x7402), IntPtr.Zero);
        for (int i = 0; i < 20 && IconsVisible() != show; i++) Thread.Sleep(25);
    }
}

static class Wallpaper
{
    [ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDesktopWallpaper
    {
        void SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID, [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);
        [return: MarshalAs(UnmanagedType.LPWStr)] string GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
        [return: MarshalAs(UnmanagedType.LPWStr)] string GetMonitorDevicePathAt(uint monitorIndex);
        uint GetMonitorDevicePathCount();
        Native.RECT GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
        void SetBackgroundColor(uint color);
        uint GetBackgroundColor();
        void SetPosition(int position);
        int GetPosition();
    }
    [ComImport, Guid("C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD")] class DesktopWallpaperClass { }

    /// <summary>{"position":4,"bg":"#rrggbb","transcoded":"…","monitors":[{"x":0,"y":0,"w":2560,"h":1440,"path":"…"}]}</summary>
    public static string Describe()
    {
        var sb = new StringBuilder("{");
        string transcoded = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"Microsoft\Windows\Themes\TranscodedWallpaper");
        sb.Append("\"transcoded\":").Append(Json(File.Exists(transcoded) ? transcoded : ""));
        try
        {
            var dw = (IDesktopWallpaper)new DesktopWallpaperClass();
            sb.Append(",\"position\":").Append(dw.GetPosition());
            uint c = dw.GetBackgroundColor(); // COLORREF 0x00bbggrr
            sb.Append(",\"bg\":\"#").Append((c & 0xFF).ToString("x2")).Append(((c >> 8) & 0xFF).ToString("x2")).Append(((c >> 16) & 0xFF).ToString("x2")).Append("\"");
            sb.Append(",\"monitors\":[");
            uint n = dw.GetMonitorDevicePathCount();
            bool first = true;
            for (uint i = 0; i < n; i++)
            {
                try
                {
                    string id = dw.GetMonitorDevicePathAt(i);
                    Native.RECT r = dw.GetMonitorRECT(id);
                    if (r.Right <= r.Left) continue;
                    string p = "";
                    try { p = dw.GetWallpaper(id) ?? ""; } catch { }
                    if (!first) sb.Append(",");
                    first = false;
                    sb.Append("{\"x\":").Append(r.Left).Append(",\"y\":").Append(r.Top).Append(",\"w\":").Append(r.Right - r.Left).Append(",\"h\":").Append(r.Bottom - r.Top).Append(",\"path\":").Append(Json(p)).Append("}");
                }
                catch { }
            }
            sb.Append("]");
            Marshal.ReleaseComObject(dw);
        }
        catch (Exception e) { sb.Append(",\"error\":").Append(Json(e.Message)); }
        return sb.Append("}").ToString();
    }

    public static string Json(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (char ch in s ?? "")
        {
            if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
            else if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
            else sb.Append(ch);
        }
        return sb.Append("\"").ToString();
    }
}

/// <summary>Extracts icons and thumbnails on its own STA thread, so a slow shell extension never holds
/// up window management.</summary>
class IconWorker
{
    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItemImageFactory
    {
        [PreserveSig] int GetImage(Native.SIZE size, int flags, out IntPtr phbm);
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);

    const int SIIGBF_ICONONLY = 0x4;
    readonly BlockingCollection<string[]> jobs = new BlockingCollection<string[]>();

    public IconWorker()
    {
        var t = new Thread(delegate ()
        {
            foreach (var j in jobs.GetConsumingEnumerable())
            {
                try { Program.Send(j[0] + "\tok\t" + Extract(j[1], int.Parse(j[2]), j[3])); }
                catch (Exception e) { Program.Send(j[0] + "\terr\t" + Program.OneLine(e.Message)); }
            }
        });
        t.IsBackground = true;
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
    }

    public void Enqueue(string id, string path, int size, string output) { jobs.Add(new[] { id, path, size.ToString(), output }); }

    class Pixels { public byte[] px; public int w, h; public bool alpha, translucent, premultiplied; }

    /// <summary>Writes a PNG for the item: game artwork for Steam shortcuts, else the thumbnail when it has
    /// one, else its icon. Returns "w h kind" (kind: icon, thumb or art).</summary>
    static string Extract(string path, int size, string output)
    {
        path = Path.GetFullPath(path.Replace('/', '\\'));
        Directory.CreateDirectory(Path.GetDirectoryName(output));
        string ext = Path.GetExtension(path).ToLowerInvariant();
        if (ext == ".url")
        {
            string art = SteamArt(path, size, output);
            if (art != null) return art;
        }
        IShellItemImageFactory f;
        SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out f);
        try
        {
            bool iconOnly = ext == ".lnk" || ext == ".url" || ext == ".exe" || Directory.Exists(path);
            Pixels p = null;
            bool thumb = false;
            if (!iconOnly) { p = Get(f, size, 0); thumb = p != null; }
            if (p == null) p = Get(f, size, SIIGBF_ICONONLY);
            if (p == null) throw new Exception("no image for this item");
            // Windows draws apps that only have small icons inside a white "document" frame at big sizes:
            // use the largest size it renders without one instead
            if (!thumb && IsFramed(p))
            {
                foreach (int s in new[] { 128, 96, 64, 48, 32 })
                {
                    if (s >= size) continue;
                    Pixels q = Get(f, s, SIIGBF_ICONONLY);
                    if (q != null && !IsFramed(q)) { p = q; break; }
                }
            }
            thumb = thumb && (!p.alpha || !p.translucent); // a real thumbnail (photo, video frame) is opaque; anything else is an icon
            using (Bitmap bmp = ToBitmap(p, !thumb))
            {
                bmp.Save(output, ImageFormat.Png);
                return bmp.Width + " " + bmp.Height + " " + (thumb ? "thumb" : "icon");
            }
        }
        finally { Marshal.ReleaseComObject(f); }
    }

    static Pixels Get(IShellItemImageFactory f, int size, int flags)
    {
        IntPtr hbm;
        if (f.GetImage(new Native.SIZE { cx = size, cy = size }, flags, out hbm) != 0 || hbm == IntPtr.Zero) return null;
        try { return Read(hbm); }
        finally { Native.DeleteObject(hbm); }
    }

    static Pixels Read(IntPtr hbm)
    {
        var bm = new Native.BITMAP();
        Native.GetObject(hbm, Marshal.SizeOf(typeof(Native.BITMAP)), ref bm);
        var p = new Pixels { w = bm.bmWidth, h = bm.bmHeight };
        var bi = new Native.BITMAPINFOHEADER { biSize = 40, biWidth = p.w, biHeight = -p.h, biPlanes = 1, biBitCount = 32, biCompression = 0 };
        p.px = new byte[p.w * p.h * 4];
        IntPtr dc = Native.GetDC(IntPtr.Zero);
        try { Native.GetDIBits(dc, hbm, 0, (uint)p.h, p.px, ref bi, 0); }
        finally { Native.ReleaseDC(IntPtr.Zero, dc); }
        p.premultiplied = true;
        for (int i = 0; i < p.px.Length; i += 4)
        {
            byte a = p.px[i + 3];
            if (a != 0) p.alpha = true;
            if (a != 255) p.translucent = true;
            if (p.px[i] > a || p.px[i + 1] > a || p.px[i + 2] > a) p.premultiplied = false;
        }
        if (!p.alpha) { for (int i = 3; i < p.px.Length; i += 4) p.px[i] = 255; p.premultiplied = false; }
        return p;
    }

    /// <summary>The faint outline Windows draws around small icons shown at big sizes: a translucent ring at
    /// all four edges with nothing just inside it.</summary>
    static bool IsFramed(Pixels p)
    {
        if (p.w < 64 || !p.alpha) return false;
        int m = Math.Max(4, p.w / 32);
        int[][] inner = { new[] { m, p.h / 2 }, new[] { p.w / 2, m }, new[] { p.w - 1 - m, p.h / 2 }, new[] { p.w / 2, p.h - 1 - m }, new[] { p.w / 4, p.h / 4 } };
        foreach (var q in inner) if (p.px[(q[1] * p.w + q[0]) * 4 + 3] > 8) return false;
        int sides = 0;
        int[][] ring = { new[] { 0, p.h / 2, 1, 0 }, new[] { p.w / 2, 0, 0, 1 }, new[] { p.w - 1, p.h / 2, -1, 0 }, new[] { p.w / 2, p.h - 1, 0, -1 } };
        foreach (var r in ring)
        {
            int best = 0;
            for (int k = 0; k < 4; k++) best = Math.Max(best, (int)p.px[((r[1] + r[3] * k) * p.w + r[0] + r[2] * k) * 4 + 3]);
            if (best >= 12 && best <= 160) sides++;
        }
        return sides >= 3;
    }

    /// <summary>32-bit bitmap with alpha. Small icons that the shell centered in a big empty canvas are
    /// cropped to their content so the UI can scale them up.</summary>
    static Bitmap ToBitmap(Pixels p, bool trim)
    {
        int w = p.w, h = p.h;
        byte[] px = p.px;
        int x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
        if (p.alpha && trim)
        {
            x0 = w; y0 = h; x1 = -1; y1 = -1;
            int e = Math.Max(2, w / 64);
            for (int y = e; y < h - e; y++)
                for (int x = e; x < w - e; x++)
                    if (px[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
            if (x1 < 0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }
            int side = Math.Max(x1 - x0 + 1, y1 - y0 + 1);
            if (side >= Math.Min(w, h) * 0.7) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }
            else
            {
                // a square around the content with a little breathing room, kept inside the canvas
                side = Math.Min(Math.Min(w, h), (int)Math.Ceiling(side * 1.08));
                int cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
                x0 = Math.Max(0, Math.Min(w - side, cx - side / 2));
                y0 = Math.Max(0, Math.Min(h - side, cy - side / 2));
                x1 = x0 + side - 1; y1 = y0 + side - 1;
            }
        }
        int ow = x1 - x0 + 1, oh = y1 - y0 + 1;
        var fmt = p.premultiplied ? PixelFormat.Format32bppPArgb : PixelFormat.Format32bppArgb;
        var bmp = new Bitmap(ow, oh, fmt);
        var data = bmp.LockBits(new Rectangle(0, 0, ow, oh), ImageLockMode.WriteOnly, fmt);
        try
        {
            for (int y = 0; y < oh; y++)
                Marshal.Copy(px, ((y0 + y) * w + x0) * 4, new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), ow * 4);
        }
        finally { bmp.UnlockBits(data); }
        return bmp;
    }

    // ---------- Steam games: their shortcut icons are tiny, but Steam keeps the library artwork ----------

    static string SteamArt(string urlFile, int size, string output)
    {
        string url = "";
        foreach (string l in File.ReadAllLines(urlFile)) if (l.StartsWith("URL=", StringComparison.OrdinalIgnoreCase)) url = l.Substring(4).Trim();
        var m = System.Text.RegularExpressions.Regex.Match(url, @"^steam://rungameid/(\d+)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (!m.Success) return null;
        string steam = null;
        try { steam = Microsoft.Win32.Registry.GetValue(@"HKEY_CURRENT_USER\Software\Valve\Steam", "SteamPath", null) as string; } catch { }
        if (string.IsNullOrEmpty(steam)) return null;
        string dir = Path.Combine(steam.Replace('/', '\\'), @"appcache\librarycache\" + m.Groups[1].Value);
        if (!Directory.Exists(dir)) return null;
        string hero = Find(dir, "library_hero.jpg"), logo = Find(dir, "logo.png"), cover = Find(dir, "library_600x900.jpg");
        string header = Find(dir, "library_header.jpg") ?? Find(dir, "header.jpg");
        if (hero == null && cover == null && header == null) return null;
        using (var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        using (var g = Graphics.FromImage(bmp))
        {
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
            if (hero != null && logo != null)
            {
                // the hero art (no text) as the background, the game's logo on top
                using (var img = Image.FromFile(hero)) DrawCover(g, img, size, 0.5f);
                using (var shade = new SolidBrush(Color.FromArgb(40, 0, 0, 0))) g.FillRectangle(shade, 0, 0, size, size);
                using (var img = Image.FromFile(logo))
                {
                    float k = Math.Min(size * 0.84f / img.Width, size * 0.56f / img.Height);
                    float lw = img.Width * k, lh = img.Height * k;
                    g.DrawImage(img, (size - lw) / 2, (size - lh) / 2, lw, lh);
                }
            }
            else
            {
                // the cover art already includes the title
                using (var img = Image.FromFile(cover ?? header ?? hero)) DrawCover(g, img, size, cover != null ? 0.35f : 0.5f);
            }
            bmp.Save(output, ImageFormat.Png);
        }
        return size + " " + size + " art";
    }

    static string Find(string dir, string name)
    {
        try
        {
            foreach (string f in Directory.GetFiles(dir, name, SearchOption.AllDirectories)) return f;
        }
        catch { }
        return null;
    }

    /// <summary>Fills the square with the image (cropped to cover; `fy` is where the crop sits vertically).</summary>
    static void DrawCover(Graphics g, Image img, int size, float fy)
    {
        float s = Math.Min(img.Width, img.Height);
        float sx = (img.Width - s) / 2, sy = (img.Height - s) * fy;
        g.DrawImage(img, new RectangleF(0, 0, size, size), new RectangleF(sx, sy, s, s), GraphicsUnit.Pixel);
    }
}

/// <summary>Reports left-button drags that start on the empty desktop: "drag" events "start|move|end x y" in
/// physical screen pixels. A low-level mouse hook on its own thread with nothing else to do, so it always
/// answers at once; it only watches - every click still goes where it was going.</summary>
static class DragWatcher
{
    const int WH_MOUSE_LL = 14, WM_MOUSEMOVE = 0x200, WM_LBUTTONDOWN = 0x201, WM_LBUTTONUP = 0x202, WM_QUIT = 0x12;
    const long WS_EX_TRANSPARENT = 0x20;
    const uint GA_ROOT = 2;
    static Thread thread;
    static uint threadId;
    static Native.LowLevelMouseProc proc;
    static IntPtr hook;
    static volatile IntPtr[] ours = new IntPtr[0];
    static bool tracking;
    static int lastMove;

    public static void Start(Host h)
    {
        ours = h.Pinned();
        if (thread != null) return;
        var started = new ManualResetEvent(false);
        thread = new Thread(delegate ()
        {
            threadId = Native.GetCurrentThreadId();
            proc = Hook;
            hook = Native.SetWindowsHookEx(WH_MOUSE_LL, proc, Native.GetModuleHandle(null), 0);
            started.Set();
            Native.MSG msg;
            while (Native.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
            if (hook != IntPtr.Zero) Native.UnhookWindowsHookEx(hook);
            hook = IntPtr.Zero;
        });
        thread.IsBackground = true;
        thread.Start();
        started.WaitOne(2000);
    }

    /// <summary>Facet's layer windows (refreshed when they change).</summary>
    public static void Ours(IntPtr[] hwnds) { ours = hwnds; }

    public static void Stop()
    {
        if (thread == null) return;
        Native.PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        thread = null;
        tracking = false;
    }

    static IntPtr Hook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            int msg = wParam.ToInt32();
            if (msg == WM_LBUTTONDOWN || (tracking && (msg == WM_MOUSEMOVE || msg == WM_LBUTTONUP)))
            {
                var info = (Native.MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.MSLLHOOKSTRUCT));
                string at = info.pt.X + " " + info.pt.Y;
                if (msg == WM_LBUTTONDOWN)
                {
                    tracking = OnDesktop(info.pt);
                    if (tracking) Program.Event("drag", "start " + at);
                }
                else if (msg == WM_MOUSEMOVE)
                {
                    int now = Environment.TickCount;
                    if (now - lastMove >= 12) { lastMove = now; Program.Event("drag", "move " + at); }
                }
                else { tracking = false; Program.Event("drag", "end " + at); }
            }
        }
        return Native.CallNextHookEx(hook, code, wParam, lParam);
    }

    /// <summary>Is the empty desktop under the point (or Facet's layer, where it lets clicks through)?</summary>
    static bool OnDesktop(Native.POINT pt)
    {
        IntPtr w = Native.WindowFromPoint(pt);
        if (w == IntPtr.Zero) return false;
        IntPtr root = Native.GetAncestor(w, GA_ROOT);
        if (Array.IndexOf(ours, root) >= 0)
            return (Native.GetWindowLongPtr(root, -20).ToInt64() & WS_EX_TRANSPARENT) != 0;
        var s = new StringBuilder(32);
        Native.GetClassName(root, s, s.Capacity);
        string c = s.ToString();
        return c == "Progman" || c == "WorkerW";
    }
}

static class Native
{
    public const uint EVENT_SYSTEM_FOREGROUND = 0x0003, EVENT_SYSTEM_MINIMIZESTART = 0x0016, WINEVENT_OUTOFCONTEXT = 0;
    public const int GWLP_HWNDPARENT = -8, GW_HWNDPREV = 3, SW_SHOWNOACTIVATE = 4;
    public const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, SWP_NOOWNERZORDER = 0x200;
    public static readonly IntPtr HWND_TOP = IntPtr.Zero;

    public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    public delegate IntPtr LowLevelMouseProc(int code, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWindowsHookEx(int id, LowLevelMouseProc fn, IntPtr mod, uint thread);
    [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetMessage(out MSG msg, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] public static extern bool PostThreadMessage(uint thread, int msg, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT pt);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
    [StructLayout(LayoutKind.Sequential)] public struct BITMAP { public int bmType, bmWidth, bmHeight, bmWidthBytes; public ushort bmPlanes, bmBitsPixel; public IntPtr bmBits; }
    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFOHEADER
    {
        public int biSize, biWidth, biHeight; public ushort biPlanes, biBitCount; public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant;
        public int pad0, pad1, pad2; // room for bit masks, should GetDIBits write any
    }

    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int RegisterWindowMessage(string name);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
    [DllImport("gdi32.dll")] public static extern int GetObject(IntPtr o, int size, ref BITMAP bm);
    [DllImport("gdi32.dll")] public static extern int GetDIBits(IntPtr dc, IntPtr bmp, uint start, uint lines, [Out] byte[] bits, ref BITMAPINFOHEADER bi, uint usage);
}
