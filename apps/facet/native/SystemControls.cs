// The Control Center's view of the system: volume (Core Audio), night light (the setting Windows keeps
// in its CloudStore), light/dark mode, Wi-Fi and Bluetooth radios, the network, monitor brightness
// (DDC/CI for external monitors, WMI for laptop panels) - and recently used folders.
// A background thread reports changes as a "sys" event (volume every second, the rest every five).
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;
using Windows.Devices.Radios;
using Windows.Networking.Connectivity;

static class SystemControls
{
    static Thread thread;
    static volatile bool running;
    static string last = "";
    static int tick;
    static string slow = "";

    public static void Watch(bool on)
    {
        if (!on) { running = false; thread = null; return; }
        if (thread != null) return;
        running = true;
        last = "";
        tick = 0;
        thread = new Thread(delegate ()
        {
            while (running)
            {
                try
                {
                    if (tick++ % 5 == 0) slow = Slow();
                    string json = "{" + Audio.Describe() + "," + slow + "}";
                    if (json != last) { last = json; Program.Event("sys", json); }
                }
                catch (Exception e) { Program.Event("error", "sys: " + Program.OneLine(e.Message)); }
                Thread.Sleep(1000);
            }
        });
        thread.IsBackground = true;
        thread.Start();
    }

    /// <summary>Asks for a fresh report on the next round (after Facet changed something).</summary>
    public static void Refresh() { tick = 0; }

    static string Slow()
    {
        var sb = new StringBuilder();
        sb.Append("\"nightlight\":").Append(NightLight.Get() ? "true" : "false");
        sb.Append(",\"dark\":").Append(Theme.IsDark() ? "true" : "false");
        sb.Append(",").Append(Radios.Describe());
        sb.Append(",").Append(Net.Describe());
        return sb.ToString();
    }
}

// ---------- volume ----------

static class Audio
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int i, out PROPERTYKEY key);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    }

    [StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public int pid; }
    [StructLayout(LayoutKind.Sequential)] struct PROPVARIANT { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public IntPtr p2; }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int GetChannelCount(out int count);
        [PreserveSig] int SetMasterVolumeLevel(float db, IntPtr context);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, IntPtr context);
        [PreserveSig] int GetMasterVolumeLevel(out float db);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(int channel, float db, IntPtr context);
        [PreserveSig] int SetChannelVolumeLevelScalar(int channel, float level, IntPtr context);
        [PreserveSig] int GetChannelVolumeLevel(int channel, out float db);
        [PreserveSig] int GetChannelVolumeLevelScalar(int channel, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, IntPtr context);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    static IMMDeviceEnumerator enumerator;

    static IMMDevice Speakers()
    {
        if (enumerator == null) enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        var e = enumerator;
        IMMDevice d;
        return e.GetDefaultAudioEndpoint(0 /* render */, 1 /* multimedia */, out d) == 0 ? d : null;
    }

    static IAudioEndpointVolume Volume(IMMDevice d)
    {
        var iid = typeof(IAudioEndpointVolume).GUID;
        object o;
        return d != null && d.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o) == 0 ? (IAudioEndpointVolume)o : null;
    }

    static string deviceName = "", deviceId = "";

    static string Name(IMMDevice d)
    {
        IPropertyStore store;
        if (d.OpenPropertyStore(0, out store) != 0) return "";
        var key = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 }; // PKEY_Device_FriendlyName
        PROPVARIANT v;
        if (store.GetValue(ref key, out v) != 0 || v.vt != 31 /* VT_LPWSTR */) return "";
        string s = Marshal.PtrToStringUni(v.p);
        Marshal.FreeCoTaskMem(v.p);
        return s ?? "";
    }

    /// <summary>"volume":0-100,"muted":bool,"device":"name" (no output device: volume null).</summary>
    public static string Describe()
    {
        var d = Speakers();
        var v = Volume(d);
        if (v == null) return "\"volume\":null,\"muted\":false,\"device\":\"\"";
        string id;
        if (d.GetId(out id) == 0 && id != deviceId) { deviceId = id; deviceName = Name(d); }
        float level; bool mute;
        v.GetMasterVolumeLevelScalar(out level);
        v.GetMute(out mute);
        return "\"volume\":" + Math.Round(level * 100) + ",\"muted\":" + (mute ? "true" : "false") + ",\"device\":" + Wallpaper.Json(deviceName);
    }

    public static void Set(int percent)
    {
        var v = Volume(Speakers());
        if (v == null) return;
        v.SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, percent)) / 100f, IntPtr.Zero);
        if (percent > 0) v.SetMute(false, IntPtr.Zero);
    }

    public static void Mute(bool mute)
    {
        var v = Volume(Speakers());
        if (v != null) v.SetMute(mute, IntPtr.Zero);
    }
}

// ---------- night light ----------

/// <summary>Windows keeps Night light's on/off state as a small serialized record in the CloudStore and
/// applies it when the record changes. Off: inner record "CB 01 00 | C6 14 <time> | 00"; on: the same with
/// "02 01" after the header. Both carry timestamps that must move forward for Windows to pick them up.</summary>
static class NightLight
{
    const string Key = @"Software\Microsoft\Windows\CurrentVersion\CloudStore\Store\DefaultAccount\Current\default$windows.data.bluelightreduction.bluelightreductionstate\windows.data.bluelightreduction.bluelightreductionstate";

    static byte[] Read()
    {
        using (var k = Registry.CurrentUser.OpenSubKey(Key)) return k == null ? null : k.GetValue("Data") as byte[];
    }

    /// <summary>The inner record starts after its length byte at 18 (header 43 42 01 00).</summary>
    public static bool Get()
    {
        var d = Read();
        return d != null && d.Length > 24 && d[19] == 0x43 && d[20] == 0x42 && d[23] == 0x02 && d[24] == 0x01;
    }

    static void Varint(List<byte> o, ulong v)
    {
        while (v >= 0x80) { o.Add((byte)(v | 0x80)); v >>= 7; }
        o.Add((byte)v);
    }

    public static bool Set(bool on)
    {
        if (Read() == null) return false; // Night light was never set up on this PC
        var inner = new List<byte> { 0x43, 0x42, 0x01, 0x00 };
        if (on) { inner.Add(0x02); inner.Add(0x01); }
        inner.Add(0xC6); inner.Add(0x14);
        Varint(inner, (ulong)DateTime.UtcNow.ToFileTimeUtc());
        inner.Add(0x00);
        var o = new List<byte> { 0x43, 0x42, 0x01, 0x00, 0x0A, 0x02, 0x01, 0x00, 0x2A, 0x06 };
        Varint(o, (ulong)DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        o.Add(0x2A); o.Add(0x2B); o.Add(0x0E);
        Varint(o, (ulong)inner.Count);
        o.AddRange(inner);
        o.AddRange(new byte[] { 0x00, 0x00, 0x00, 0x00 });
        using (var k = Registry.CurrentUser.CreateSubKey(Key)) k.SetValue("Data", o.ToArray(), RegistryValueKind.Binary);
        return true;
    }
}

// ---------- light / dark mode ----------

static class Theme
{
    const string Key = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

    public static bool IsDark()
    {
        using (var k = Registry.CurrentUser.OpenSubKey(Key))
        {
            object v = k == null ? null : k.GetValue("AppsUseLightTheme");
            return v is int && (int)v == 0;
        }
    }

    public static void Set(bool dark)
    {
        using (var k = Registry.CurrentUser.CreateSubKey(Key))
        {
            k.SetValue("AppsUseLightTheme", dark ? 0 : 1, RegistryValueKind.DWord);
            k.SetValue("SystemUsesLightTheme", dark ? 0 : 1, RegistryValueKind.DWord);
        }
        // tell everything (Explorer, the taskbar, apps) to look again
        IntPtr result;
        SendMessageTimeout(new IntPtr(0xffff), 0x001A, IntPtr.Zero, "ImmersiveColorSet", 0x0002, 1000, out result);
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr SendMessageTimeout(IntPtr h, int msg, IntPtr w, string l, int flags, int timeout, out IntPtr result);
}

// ---------- Wi-Fi / Bluetooth ----------

static class Radios
{
    static bool access;

    static IList<Radio> All()
    {
        if (!access) access = Radio.RequestAccessAsync().Wait() == RadioAccessStatus.Allowed;
        var list = new List<Radio>();
        if (!access) return list;
        foreach (var r in Radio.GetRadiosAsync().Wait()) list.Add(r);
        return list;
    }

    /// <summary>"wifi":true|false|null,"bluetooth":true|false|null (null: no such radio).</summary>
    public static string Describe()
    {
        string wifi = "null", bt = "null";
        try
        {
            foreach (var r in All())
            {
                string on = r.State == RadioState.On ? "true" : "false";
                if (r.Kind == RadioKind.WiFi) wifi = on;
                if (r.Kind == RadioKind.Bluetooth) bt = on;
            }
        }
        catch { }
        return "\"wifi\":" + wifi + ",\"bluetooth\":" + bt;
    }

    public static bool Set(string kind, bool on)
    {
        foreach (var r in All())
        {
            if ((kind == "wifi" && r.Kind == RadioKind.WiFi) || (kind == "bluetooth" && r.Kind == RadioKind.Bluetooth))
                return r.SetStateAsync(on ? RadioState.On : RadioState.Off).Wait() == RadioAccessStatus.Allowed;
        }
        return false;
    }
}

// ---------- network ----------

static class Net
{
    /// <summary>"net":{"name":"…","wifi":bool,"bars":0-5|null} or null when offline.</summary>
    public static string Describe()
    {
        try
        {
            var p = NetworkInformation.GetInternetConnectionProfile();
            if (p == null) return "\"net\":null";
            var bars = p.GetSignalBars();
            return "\"net\":{\"name\":" + Wallpaper.Json(p.ProfileName) + ",\"wifi\":" + (p.IsWlanConnectionProfile ? "true" : "false") + ",\"bars\":" + (bars.HasValue ? bars.Value.ToString() : "null") + "}";
        }
        catch { return "\"net\":null"; }
    }
}

// ---------- brightness ----------

/// <summary>Hardware brightness: DDC/CI for external monitors (when the monitor allows it), WMI for laptop
/// panels. Calls can take a while (DDC/CI is a slow bus), so they run on their own thread and only the
/// newest value per monitor is sent.</summary>
static class Brightness
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PHYSICAL_MONITOR { public IntPtr h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string desc; }
    delegate bool MonitorEnumProc(IntPtr hmon, IntPtr hdc, ref Native.RECT rect, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc f, IntPtr data);
    [DllImport("dxva2.dll")] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr h, out uint n);
    [DllImport("dxva2.dll")] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr h, uint n, [Out] PHYSICAL_MONITOR[] arr);
    [DllImport("dxva2.dll")] static extern bool DestroyPhysicalMonitors(uint n, PHYSICAL_MONITOR[] arr);
    [DllImport("dxva2.dll")] static extern bool GetMonitorBrightness(IntPtr h, out uint min, out uint cur, out uint max);
    [DllImport("dxva2.dll")] static extern bool SetMonitorBrightness(IntPtr h, uint value);

    class Mon { public Native.RECT rect; public PHYSICAL_MONITOR[] phys; public uint min, max, value; public bool ddc; }
    static List<Mon> mons;
    static readonly object gate = new object();
    static readonly Dictionary<string, int> pending = new Dictionary<string, int>();
    static Thread worker;
    static readonly AutoResetEvent wake = new AutoResetEvent(false);

    static List<Mon> Monitors()
    {
        if (mons != null) return mons;
        var list = new List<Mon>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr h, IntPtr dc, ref Native.RECT r, IntPtr d)
        {
            var m = new Mon { rect = r };
            uint n;
            if (GetNumberOfPhysicalMonitorsFromHMONITOR(h, out n) && n > 0)
            {
                m.phys = new PHYSICAL_MONITOR[n];
                if (GetPhysicalMonitorsFromHMONITOR(h, n, m.phys))
                {
                    uint min, cur, max;
                    if (GetMonitorBrightness(m.phys[0].h, out min, out cur, out max) && max > min) { m.ddc = true; m.min = min; m.max = max; m.value = cur; }
                }
            }
            list.Add(m);
            return true;
        }, IntPtr.Zero);
        mons = list;
        return list;
    }

    /// <summary>A laptop panel's brightness (0-100) through WMI, or -1.</summary>
    static int Wmi()
    {
        try
        {
            using (var s = new System.Management.ManagementObjectSearcher(@"root\WMI", "SELECT CurrentBrightness FROM WmiMonitorBrightness"))
                foreach (System.Management.ManagementObject o in s.Get()) return Convert.ToInt32(o["CurrentBrightness"]);
        }
        catch { }
        return -1;
    }

    static void SetWmi(int value)
    {
        using (var s = new System.Management.ManagementObjectSearcher(@"root\WMI", "SELECT * FROM WmiMonitorBrightnessMethods"))
            foreach (System.Management.ManagementObject o in s.Get()) o.InvokeMethod("WmiSetBrightness", new object[] { (uint)1, (byte)value });
    }

    /// <summary>{"monitors":[{"x":…,"y":…,"w":…,"h":…,"ddc":bool,"value":0-100}],"wmi":0-100|-1}</summary>
    public static string Describe()
    {
        lock (gate)
        {
            mons = null; // monitors come and go
            var sb = new StringBuilder("{\"monitors\":[");
            bool first = true;
            foreach (var m in Monitors())
            {
                if (!first) sb.Append(",");
                first = false;
                int pct = m.ddc ? (int)Math.Round(100.0 * (m.value - m.min) / (m.max - m.min)) : -1;
                sb.Append("{\"x\":").Append(m.rect.Left).Append(",\"y\":").Append(m.rect.Top).Append(",\"w\":").Append(m.rect.Right - m.rect.Left)
                  .Append(",\"h\":").Append(m.rect.Bottom - m.rect.Top).Append(",\"ddc\":").Append(m.ddc ? "true" : "false").Append(",\"value\":").Append(pct).Append("}");
            }
            return sb.Append("],\"wmi\":").Append(Wmi()).Append("}").ToString();
        }
    }

    /// <summary>target: a monitor index or "wmi"; queued - the worker applies only the newest value.</summary>
    public static void Set(string target, int percent)
    {
        lock (pending) pending[target] = Math.Max(0, Math.Min(100, percent));
        if (worker == null)
        {
            worker = new Thread(delegate ()
            {
                while (true)
                {
                    wake.WaitOne();
                    while (true)
                    {
                        string t; int v;
                        lock (pending)
                        {
                            if (pending.Count == 0) break;
                            var e = pending.GetEnumerator(); e.MoveNext();
                            t = e.Current.Key; v = e.Current.Value;
                            pending.Remove(t);
                        }
                        try { Apply(t, v); } catch { }
                    }
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }
        wake.Set();
    }

    static void Apply(string target, int pct)
    {
        if (target == "wmi") { SetWmi(pct); return; }
        lock (gate)
        {
            var list = Monitors();
            int i = int.Parse(target);
            if (i < 0 || i >= list.Count || !list[i].ddc) return;
            var m = list[i];
            uint v = (uint)(m.min + (m.max - m.min) * pct / 100);
            foreach (var p in m.phys) SetMonitorBrightness(p.h, v);
            m.value = v;
        }
    }
}

// ---------- recently used folders ----------

/// <summary>Windows keeps a shortcut in %APPDATA%\Microsoft\Windows\Recent for everything opened recently,
/// folders included. Resolving hundreds of shortcuts takes a while, so results are cached per shortcut.</summary>
static class Recent
{
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink { }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellLinkW
    {
        [PreserveSig] int GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int max, IntPtr data, int flags);
    }

    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPersistFile
    {
        [PreserveSig] int GetClassID(out Guid id);
        [PreserveSig] int IsDirty();
        [PreserveSig] int Load([MarshalAs(UnmanagedType.LPWStr)] string file, int mode);
    }

    class Entry { public long stamp; public string target; }
    static readonly Dictionary<string, Entry> cache = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);

    static string Target(string lnk)
    {
        var link = new ShellLink();
        try
        {
            ((IPersistFile)link).Load(lnk, 0);
            var sb = new StringBuilder(1024);
            ((IShellLinkW)link).GetPath(sb, sb.Capacity, IntPtr.Zero, 0); // the stored path; no searching for moved targets
            return sb.ToString();
        }
        catch { return ""; }
        finally { Marshal.ReleaseComObject(link); }
    }

    /// <summary>[{"path":…,"time":ms}] - the newest `count` folders that still exist.</summary>
    public static string List(int count)
    {
        string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"Microsoft\Windows\Recent");
        var files = new List<FileInfo>();
        try { files.AddRange(new DirectoryInfo(dir).GetFiles("*.lnk")); } catch { }
        files.Sort(delegate (FileInfo a, FileInfo b) { return b.LastWriteTimeUtc.CompareTo(a.LastWriteTimeUtc); });
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var sb = new StringBuilder("[");
        int n = 0;
        foreach (var f in files)
        {
            if (n >= count) break;
            if (seen.Count > 400) break; // older than that isn't "recent"
            Entry e;
            long stamp = f.LastWriteTimeUtc.Ticks;
            if (!cache.TryGetValue(f.FullName, out e) || e.stamp != stamp) { e = new Entry { stamp = stamp, target = Target(f.FullName) }; cache[f.FullName] = e; }
            string t = e.target;
            if (string.IsNullOrEmpty(t) || !seen.Add(t)) continue;
            // local folders only: a disconnected network share or drive would stall the check
            if (t.StartsWith(@"\\")) continue;
            try { if (!Directory.Exists(t)) continue; } catch { continue; }
            if (n > 0) sb.Append(",");
            sb.Append("{\"path\":").Append(Wallpaper.Json(t)).Append(",\"time\":").Append((long)(f.LastWriteTimeUtc - new DateTime(1970, 1, 1)).TotalMilliseconds).Append("}");
            n++;
        }
        return sb.Append("]").ToString();
    }
}
