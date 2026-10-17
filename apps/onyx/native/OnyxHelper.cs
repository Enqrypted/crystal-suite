// Onyx's Windows helper: records the last minutes of game windows into memory (see Video.cs and Audio.cs) and
// writes them out on request, and tells Onyx which window is in front so it can spot games. Several windows
// can be recorded at once (each its own replay buffer); the sound is captured once and shared.
//
// Protocol (UTF-8 lines on stdin/stdout, tab-separated), like Facet's helper:
//   request  "<id>\t<command>\t<arg>..."     reply  "<id>\tok\t<result>" or "<id>\terr\t<message>"
//   event    "0\tevent\t<name>\t<data>"      (recording events: "<recording>\t<data>")
// Commands:
//   audio  <system 0/1> <mic 0/1>             what sound goes into recordings
//   start  <recording> <window|monitor> <handle> <fps> <maxHeight> <quality 0-2> <seconds> [<window to outlive>]
//   stop   [<recording>]                      one recording, or all
//   save   <recording> <seconds> <dump path>  writes the clip's packets for Onyx to put in an MP4
//   windows                                   visible top-level windows (JSON)
//   monitors                                  the displays (JSON)
//   foreground                                the window in front (JSON)
// Events: status <recording> <json> (each second), stopped <recording> <why>, error <recording> <message>,
// foreground <json>. The helper exits when stdin closes.
//
// Built with the C# compiler that ships with Windows (.NET Framework 4.x), so C# 5 syntax only.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Onyx
{
    static class Program
    {
        public const string Version = "2";
        public static bool Debug;
        /// <summary>The clock every recording and the sound share (100 ns units).</summary>
        public static long T0;
        public static AudioHub Audio;
        static TextWriter stdout;
        static readonly BlockingCollection<string> outbox = new BlockingCollection<string>();
        static readonly Dictionary<string, Recorder> recorders = new Dictionary<string, Recorder>();
        static readonly object gate = new object();

        public static void Send(string line) { outbox.Add(line); }
        public static void Event(string name, string data) { Send("0\tevent\t" + name + "\t" + (data ?? "")); }

        [MTAThread]
        static int Main(string[] args)
        {
            try { Win32.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
            Win32.timeBeginPeriod(1);
            HR.Check(MFApi.MFStartup(MFApi.MF_VERSION, 0), "MFStartup");
            T0 = Win32.Now100ns();
            Audio = new AudioHub(T0);
            if (args.Length > 0 && args[0] == "selftest") { Debug = true; return SelfTest(args); }

            stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            var writer = new Thread(delegate ()
            {
                foreach (var line in outbox.GetConsumingEnumerable()) { try { stdout.Write(line + "\n"); stdout.Flush(); } catch { } }
            });
            writer.IsBackground = true;
            writer.Start();
            Foreground.Start();
            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            Event("ready", Version);
            string l;
            try { while ((l = stdin.ReadLine()) != null) Dispatch(l); } catch { }
            lock (gate) { foreach (var k in new List<string>(recorders.Keys)) Drop(k); }
            Audio.Dispose();
            return 0;
        }

        static void Dispatch(string line)
        {
            string[] a = line.Split('\t');
            if (a.Length < 2) return;
            string id = a[0], cmd = a[1];
            try
            {
                switch (cmd)
                {
                    case "hello": Send(id + "\tok\t" + Version); break;
                    case "windows": Send(id + "\tok\t" + WindowList.List()); break;
                    case "monitors": Send(id + "\tok\t" + WindowList.Monitors()); break;
                    case "foreground": Send(id + "\tok\t" + Foreground.Describe(Win32.GetForegroundWindow())); break;
                    case "audio":
                        Audio.Configure(a[2] == "1", a[3] == "1");
                        Send(id + "\tok\t" + Clean(Audio.Problem));
                        break;
                    case "start":
                        {
                            string name = a[2];
                            var o = new RecorderOptions
                            {
                                Monitor = a[3] == "monitor",
                                Handle = new IntPtr(long.Parse(a[4], CultureInfo.InvariantCulture)),
                                Fps = int.Parse(a[5], CultureInfo.InvariantCulture),
                                MaxHeight = int.Parse(a[6], CultureInfo.InvariantCulture),
                                Quality = int.Parse(a[7], CultureInfo.InvariantCulture),
                                Seconds = int.Parse(a[8], CultureInfo.InvariantCulture),
                                Watch = a.Length > 9 && a[9].Length > 0 ? new IntPtr(long.Parse(a[9], CultureInfo.InvariantCulture)) : IntPtr.Zero,
                            };
                            lock (gate)
                            {
                                Drop(name);
                                var r = new Recorder(name, o);
                                recorders[name] = r;
                                Send(id + "\tok\t" + r.Describe());
                            }
                            break;
                        }
                    case "stop":
                        lock (gate)
                        {
                            if (a.Length > 2 && a[2].Length > 0) Drop(a[2]);
                            else foreach (var k in new List<string>(recorders.Keys)) Drop(k);
                        }
                        Send(id + "\tok\t");
                        break;
                    case "save":
                        {
                            Recorder r;
                            lock (gate) recorders.TryGetValue(a[2], out r);
                            if (r == null) { Send(id + "\terr\tThat game isn't being recorded any more."); break; }
                            double seconds = double.Parse(a[3], CultureInfo.InvariantCulture);
                            string path = a[4];
                            // writing a couple of hundred megabytes takes a moment: off the command thread
                            ThreadPool.QueueUserWorkItem(delegate
                            {
                                try { Send(id + "\tok\t" + r.Save(seconds, path)); }
                                catch (Exception e) { Send(id + "\terr\t" + Clean(e.Message)); }
                            });
                            break;
                        }
                    default: Send(id + "\terr\tunknown command"); break;
                }
            }
            catch (Exception e) { Send(id + "\terr\t" + Clean(e.Message)); }
        }

        // two minutes of video is a few hundred megabytes: hand it back to Windows right away
        static void Drop(string name)
        {
            Recorder r;
            if (!recorders.TryGetValue(name, out r)) return;
            recorders.Remove(name);
            r.Dispose();
            GC.Collect();
        }

        public static string Clean(string s) { return (s ?? "").Replace('\t', ' ').Replace('\n', ' ').Replace('\r', ' '); }

        /// <summary>`selftest <hwnd> <seconds> <dump> [maxHeight] [monitor]`: records a window (or its screen) for a few
        /// seconds and saves it (for development).</summary>
        static int SelfTest(string[] args)
        {
            var o = new RecorderOptions { Handle = new IntPtr(long.Parse(args[1])), Fps = 60, MaxHeight = args.Length > 4 ? int.Parse(args[4]) : 1080, Quality = 1, Seconds = 120 };
            if (args.Length > 5 && args[5] == "monitor") { o.Monitor = true; o.Watch = o.Handle; o.Handle = Win32.MonitorFromWindow(o.Handle, Win32.MONITOR_DEFAULTTONEAREST); }
            Audio.Configure(true, false);
            using (var r = new Recorder("test", o))
            {
                Console.WriteLine(r.Describe());
                int secs = int.Parse(args[2]);
                for (int i = 0; i < secs; i++) { Thread.Sleep(1000); Console.WriteLine(r.Status()); }
                Console.WriteLine(r.Save(secs, args[3]));
            }
            Audio.Dispose();
            return 0;
        }
    }

    // ---------------------------------------------------------------- recording

    sealed class RecorderOptions
    {
        public bool Monitor;
        public IntPtr Handle;
        /// <summary>For a screen recorded in place of a game's window: the game's window (it ends with it).</summary>
        public IntPtr Watch;
        public int Fps = 60, MaxHeight, Quality = 1, Seconds = 120;
    }

    sealed class Packet
    {
        public byte[] Data;
        public long Time, Duration;
    }

    /// <summary>One replay buffer: a capture, the shared sound and the last `Seconds` of packets (from a keyframe on).</summary>
    sealed class Recorder : IDisposable
    {
        readonly string name;
        readonly RecorderOptions options;
        readonly Capture capture;
        readonly PacketStore video = new PacketStore();
        readonly List<Packet> sound = new List<Packet>();
        long soundBytes;
        readonly object gate = new object();
        readonly long span;
        long frames0, lastTick;
        double fps;
        readonly Timer timer;
        string stopped;

        public Recorder(string name, RecorderOptions o)
        {
            this.name = name;
            options = o;
            span = (o.Seconds + 3) * 10000000L;
            capture = new Capture(o.Handle, o.Monitor, o.Watch, o.Fps, o.MaxHeight, o.Quality, Program.T0, OnVideo,
                delegate (string e) { Program.Event("error", name + "\t" + Program.Clean(e)); });
            capture.OnStopped = delegate (string why) { stopped = why; Program.Event("stopped", name + "\t" + Program.Clean(why)); };
            Program.Audio.Subscribe(OnAudio);
            timer = new Timer(delegate { Tick(); Program.Event("status", name + "\t" + Status()); }, null, 1000, 1000);
        }

        void OnVideo(IntPtr data, int length, long time, long duration, bool key)
        {
            lock (gate)
            {
                video.Append(data, length, time, duration, key);
                // keep `span`, starting at a keyframe
                var list = video.Entries;
                long cutoff = time - span;
                int k = -1;
                for (int i = 0; i < list.Count && list[i].Time <= cutoff; i++) if (list[i].Key) k = i;
                if (k > 0) video.RemoveFirst(k);
                long first = list[0].Time - 10000000L;
                int n = 0;
                while (n < sound.Count && sound[n].Time < first) { soundBytes -= sound[n].Data.Length; n++; }
                if (n > 0) sound.RemoveRange(0, n);
            }
        }

        void OnAudio(byte[] data, long time, long duration)
        {
            lock (gate)
            {
                // nothing to go with yet: sound is kept from a second before the oldest frame
                if (video.Entries.Count == 0 && sound.Count > 200) { soundBytes -= sound[0].Data.Length; sound.RemoveAt(0); }
                sound.Add(new Packet { Data = data, Time = time, Duration = duration });
                soundBytes += data.Length;
            }
        }

        public string Describe()
        {
            var j = new Json();
            j.Num("width", capture.Width).Num("height", capture.Height).Num("fps", capture.Fps).Num("kbps", capture.Kbps)
             .Str("encoder", capture.Encoder.Name).Bool("hardware", capture.Encoder.Hardware).Str("gpu", capture.Gpu.Name)
             .Str("audioProblem", Program.Audio.Problem);
            return j.ToString();
        }

        // the capture rate over the last second (the timer's job, so other callers don't skew it)
        void Tick()
        {
            long now = Environment.TickCount;
            long frames = capture.Frames;
            if (lastTick != 0) fps = (frames - frames0) * 1000.0 / Math.Max(1, now - lastTick);
            frames0 = frames; lastTick = now;
        }

        public string Status()
        {
            double buffered;
            int count;
            long b;
            lock (gate)
            {
                var list = video.Entries;
                buffered = list.Count > 1 ? (list[list.Count - 1].Time + list[list.Count - 1].Duration - list[0].Time) / 1e7 : 0;
                count = list.Count;
                b = video.Bytes + soundBytes;
            }
            var j = new Json();
            j.Num("fps", Math.Round(fps, 1)).Num("buffered", Math.Round(Math.Min(buffered, options.Seconds), 1)).Num("bytes", b)
             .Num("dropped", capture.Dropped).Num("frames", capture.Frames).Num("packets", count).Num("inFlight", capture.Encoder.InFlight)
             .Str("audioProblem", Program.Audio.Problem).Str("stopped", stopped ?? "");
            return j.ToString();
        }

        /// <summary>Writes the last `seconds` (from the keyframe before) to `path`: a JSON header line, then packets
        /// as [u8 track][u8 key][i64 time][i64 duration][i32 length][data], video and audio interleaved by time.</summary>
        public string Save(double seconds, string path)
        {
            List<Entry> v;
            List<Packet> s;
            lock (gate)
            {
                var list = video.Entries;
                if (list.Count == 0) throw new Exception("Nothing recorded yet.");
                long end = list[list.Count - 1].Time + list[list.Count - 1].Duration;
                long cutoff = end - (long)(seconds * 1e7);
                int k = 0;
                for (int i = 0; i < list.Count && list[i].Time <= cutoff; i++) if (list[i].Key) k = i;
                while (k < list.Count && !list[k].Key) k++;
                if (k >= list.Count) throw new Exception("No keyframe yet.");
                v = list.GetRange(k, list.Count - k);
                long start = v[0].Time;
                s = new List<Packet>();
                foreach (var p in sound) if (p.Time >= start && p.Time < end) s.Add(p);
                video.Readers++;
            }
            try
            {
                var header = new Json();
                header.Num("version", 1).Num("width", capture.Width).Num("height", capture.Height).Num("fps", capture.Fps)
                      .Str("videoHeader", capture.Encoder.SequenceHeader != null ? Convert.ToBase64String(capture.Encoder.SequenceHeader) : "")
                      .Str("audioConfig", s.Count > 0 ? Convert.ToBase64String(Program.Audio.Config) : "")
                      .Num("start", v[0].Time).Str("encoder", capture.Encoder.Name);
                long total = 0;
                var scratch = new byte[1 << 20];
                using (var f = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read, 1 << 20))
                using (var w = new BinaryWriter(f))
                {
                    w.Write(Encoding.UTF8.GetBytes(header.ToString() + "\n"));
                    int ai = 0;
                    foreach (var e in v)
                    {
                        while (ai < s.Count && s[ai].Time <= e.Time) { var a = s[ai++]; Write(w, 1, true, a.Time, a.Duration, a.Data, a.Data.Length); total += a.Data.Length; }
                        if (scratch.Length < e.Length) scratch = new byte[e.Length + (e.Length >> 2)];
                        lock (gate) video.CopyTo(e, scratch);
                        Write(w, 0, e.Key, e.Time, e.Duration, scratch, e.Length);
                        total += e.Length;
                    }
                    while (ai < s.Count) { var a = s[ai++]; Write(w, 1, true, a.Time, a.Duration, a.Data, a.Data.Length); total += a.Data.Length; }
                }
                double dur = (v[v.Count - 1].Time + v[v.Count - 1].Duration - v[0].Time) / 1e7;
                var r = new Json();
                r.Num("duration", Math.Round(dur, 2)).Num("bytes", total).Num("videoPackets", v.Count).Num("audioPackets", s.Count);
                return r.ToString();
            }
            finally { lock (gate) { video.Readers--; video.Release(); } }
        }

        static void Write(BinaryWriter w, byte track, bool key, long time, long duration, byte[] data, int length)
        {
            w.Write(track);
            w.Write((byte)(key ? 1 : 0));
            w.Write(time);
            w.Write(duration);
            w.Write(length);
            w.Write(data, 0, length);
        }

        public void Dispose()
        {
            timer.Dispose();
            Program.Audio.Unsubscribe(OnAudio);
            capture.Dispose();
            // a save still running keeps its blocks; the collector takes them after
            lock (gate) { if (video.Readers == 0) video.Clear(); sound.Clear(); soundBytes = 0; }
        }
    }

    // ---------------------------------------------------------------- windows and games

    static class WindowList
    {
        /// <summary>Visible top-level windows with a title (what Onyx offers when choosing a window).</summary>
        public static string List()
        {
            var sb = new StringBuilder("[");
            bool first = true;
            Win32.EnumWindows(delegate (IntPtr h, IntPtr _)
            {
                if (!Win32.IsWindowVisible(h) || Win32.GetWindow(h, Win32.GW_OWNER) != IntPtr.Zero) return true;
                if ((Win32.GetWindowLong(h, Win32.GWL_EXSTYLE) & Win32.WS_EX_TOOLWINDOW) != 0) return true;
                int cloaked;
                if (Win32.DwmGetWindowAttribute(h, Win32.DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;
                RECT r;
                Win32.GetWindowRect(h, out r);
                if (r.Right - r.Left < 160 || r.Bottom - r.Top < 120) return true;
                string title = Foreground.Title(h);
                if (title.Length == 0) return true;
                if (!first) sb.Append(',');
                first = false;
                sb.Append(Foreground.Describe(h));
                return true;
            }, IntPtr.Zero);
            return sb.Append(']').ToString();
        }

        /// <summary>The displays, in physical pixels (Onyx matches them to its own list by position).</summary>
        public static string Monitors()
        {
            var sb = new StringBuilder("[");
            bool first = true;
            Win32.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr m, IntPtr hdc, ref RECT r, IntPtr data)
            {
                var mi = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
                Win32.GetMonitorInfo(m, ref mi);
                if (!first) sb.Append(',');
                first = false;
                var j = new Json();
                j.Str("handle", m.ToInt64().ToString(CultureInfo.InvariantCulture)).Num("x", r.Left).Num("y", r.Top)
                 .Num("w", r.Right - r.Left).Num("h", r.Bottom - r.Top).Bool("primary", (mi.dwFlags & 1) != 0);
                sb.Append(j.ToString());
                return true;
            }, IntPtr.Zero);
            return sb.Append(']').ToString();
        }
    }

    static class Foreground
    {
        static IntPtr last;
        static string lastInfo = "";

        public static void Start()
        {
            var t = new Thread(delegate ()
            {
                for (; ; )
                {
                    Thread.Sleep(700);
                    try
                    {
                        IntPtr h = Win32.GetForegroundWindow();
                        if (h == IntPtr.Zero) continue;
                        string info = Describe(h);
                        // a new window in front, or the same one going fullscreen / changing title
                        if (h != last || info != lastInfo) { last = h; lastInfo = info; Program.Event("foreground", info); }
                    }
                    catch { }
                }
            });
            t.IsBackground = true;
            t.Name = "foreground";
            t.Start();
        }

        public static string Title(IntPtr h)
        {
            var sb = new StringBuilder(512);
            Win32.GetWindowText(h, sb, 512);
            return sb.ToString();
        }

        public static string Describe(IntPtr h)
        {
            int pid;
            Win32.GetWindowThreadProcessId(h, out pid);
            string exe = "";
            IntPtr p = Win32.OpenProcess(Win32.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (p != IntPtr.Zero)
            {
                var sb = new StringBuilder(1024);
                int size = sb.Capacity;
                if (Win32.QueryFullProcessImageName(p, 0, sb, ref size)) exe = sb.ToString();
                Win32.CloseHandle(p);
            }
            var cls = new StringBuilder(256);
            Win32.GetClassName(h, cls, 256);
            RECT r;
            Win32.GetWindowRect(h, out r);
            var mi = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
            IntPtr mon = Win32.MonitorFromWindow(h, Win32.MONITOR_DEFAULTTONEAREST);
            Win32.GetMonitorInfo(mon, ref mi);
            bool fullscreen = r.Left <= mi.rcMonitor.Left && r.Top <= mi.rcMonitor.Top && r.Right >= mi.rcMonitor.Right && r.Bottom >= mi.rcMonitor.Bottom;
            var j = new Json();
            j.Str("hwnd", h.ToInt64().ToString(CultureInfo.InvariantCulture)).Num("pid", pid).Str("exe", exe).Str("title", Title(h)).Str("cls", cls.ToString())
             .Bool("fullscreen", fullscreen).Bool("minimized", Win32.IsIconic(h))
             .Num("w", r.Right - r.Left).Num("h", r.Bottom - r.Top)
             .Str("monitor", mon.ToInt64().ToString(CultureInfo.InvariantCulture))
             .Num("mx", mi.rcMonitor.Left).Num("my", mi.rcMonitor.Top).Num("mw", mi.rcMonitor.Right - mi.rcMonitor.Left).Num("mh", mi.rcMonitor.Bottom - mi.rcMonitor.Top)
             .Str("parent", ParentOf(pid));
            return j.ToString();
        }

        // pid -> the program that started it (and when that was looked up)
        static readonly Dictionary<int, KeyValuePair<string, int>> parents = new Dictionary<int, KeyValuePair<string, int>>();

        /// <summary>File name of the program that started `pid` (a game launcher starts games). One look at all
        /// processes answers for every window at once; answers are kept for a minute (process ids get reused).</summary>
        public static string ParentOf(int pid)
        {
            lock (parents)
            {
                KeyValuePair<string, int> hit;
                if (parents.TryGetValue(pid, out hit) && Environment.TickCount - hit.Value < 60000) return hit.Key;
                var parentPid = new Dictionary<int, int>();
                var names = new Dictionary<int, string>();
                IntPtr snap = Toolhelp.CreateToolhelp32Snapshot(Toolhelp.TH32CS_SNAPPROCESS, 0);
                if (snap == new IntPtr(-1)) return "";
                try
                {
                    var e = new PROCESSENTRY32 { dwSize = Marshal.SizeOf(typeof(PROCESSENTRY32)) };
                    for (bool ok = Toolhelp.Process32First(snap, ref e); ok; ok = Toolhelp.Process32Next(snap, ref e))
                    {
                        parentPid[e.th32ProcessID] = e.th32ParentProcessID;
                        names[e.th32ProcessID] = e.szExeFile ?? "";
                    }
                }
                finally { Win32.CloseHandle(snap); }
                if (parents.Count > 4000) parents.Clear();
                int now = Environment.TickCount;
                foreach (var kv in parentPid)
                {
                    string n;
                    parents[kv.Key] = new KeyValuePair<string, int>(names.TryGetValue(kv.Value, out n) ? n : "", now);
                }
                return parents.TryGetValue(pid, out hit) ? hit.Key : "";
            }
        }
    }

    /// <summary>A tiny JSON object writer (the .NET Framework has none built in).</summary>
    sealed class Json
    {
        readonly StringBuilder sb = new StringBuilder("{");
        bool any;
        Json Key(string k) { if (any) sb.Append(','); any = true; Quote(k); sb.Append(':'); return this; }
        public Json Str(string k, string v) { Key(k); Quote(v ?? ""); return this; }
        public Json Num(string k, double v) { Key(k); sb.Append(v.ToString("R", CultureInfo.InvariantCulture)); return this; }
        public Json Num(string k, long v) { Key(k); sb.Append(v.ToString(CultureInfo.InvariantCulture)); return this; }
        public Json Bool(string k, bool v) { Key(k); sb.Append(v ? "true" : "false"); return this; }
        void Quote(string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            sb.Append('"');
        }
        public override string ToString() { return sb.ToString() + "}"; }
    }
}
