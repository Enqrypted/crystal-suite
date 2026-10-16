// What's playing, through Windows' media controls (the same source as the volume flyout): Spotify, or
// whatever app is playing. A background thread checks every second and reports changes as a "media" event:
// {"spotify":{...}|null,"current":{...}|null}. Album art is written to Facet's cache folder.
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Storage.Streams;

static class WinRT
{
    /// <summary>Waits for a WinRT async operation (no task bridge needed on .NET Framework).</summary>
    public static T Wait<T>(this IAsyncOperation<T> op, int timeoutMs = 5000)
    {
        int waited = 0;
        while (op.Status == AsyncStatus.Started && waited < timeoutMs) { Thread.Sleep(3); waited += 3; }
        if (op.Status != AsyncStatus.Completed) throw new Exception("async " + op.Status);
        return op.GetResults();
    }
}

static class Media
{
    static Thread thread;
    static volatile bool running;
    static string artDir = "";
    static string last = "";
    static readonly Dictionary<string, string> artFor = new Dictionary<string, string>();
    static GlobalSystemMediaTransportControlsSessionManager manager;

    public static void Watch(bool on, string dir)
    {
        if (!string.IsNullOrEmpty(dir)) artDir = dir;
        if (!on) { running = false; thread = null; return; }
        if (thread != null) return;
        running = true;
        last = "";
        thread = new Thread(delegate ()
        {
            while (running)
            {
                try { Poll(); } catch (Exception e) { Program.Event("error", "media: " + Program.OneLine(e.Message)); manager = null; Thread.Sleep(3000); }
                Thread.Sleep(1000);
            }
        });
        thread.IsBackground = true; // MTA: WinRT calls complete without a message loop
        thread.Start();
    }

    static GlobalSystemMediaTransportControlsSessionManager Manager()
    {
        if (manager == null) manager = GlobalSystemMediaTransportControlsSessionManager.RequestAsync().Wait();
        return manager;
    }

    static GlobalSystemMediaTransportControlsSession Spotify(GlobalSystemMediaTransportControlsSessionManager m)
    {
        foreach (var s in m.GetSessions())
            if ((s.SourceAppUserModelId ?? "").IndexOf("spotify", StringComparison.OrdinalIgnoreCase) >= 0) return s;
        return null;
    }

    static void Poll()
    {
        var m = Manager();
        var spotify = Spotify(m);
        var current = m.GetCurrentSession();
        string sj = Describe(spotify);
        string cj = current != null && spotify != null && current.SourceAppUserModelId == spotify.SourceAppUserModelId ? sj : Describe(current);
        string json = "{\"spotify\":" + sj + ",\"current\":" + cj + "}";
        if (json != last) { last = json; Program.Event("media", json); }
    }

    static string Describe(GlobalSystemMediaTransportControlsSession s)
    {
        if (s == null) return "null";
        var p = s.TryGetMediaPropertiesAsync().Wait();
        var pb = s.GetPlaybackInfo();
        var tl = s.GetTimelineProperties();
        string key = s.SourceAppUserModelId + "|" + p.Title + "|" + p.Artist + "|" + p.AlbumTitle;
        string art;
        if (!artFor.TryGetValue(key, out art)) { art = SaveArt(p, key); if (art != "") artFor[key] = art; }
        var c = pb.Controls;
        var sb = new StringBuilder("{");
        sb.Append("\"app\":").Append(Wallpaper.Json(s.SourceAppUserModelId));
        sb.Append(",\"title\":").Append(Wallpaper.Json(p.Title));
        sb.Append(",\"artist\":").Append(Wallpaper.Json(p.Artist));
        sb.Append(",\"album\":").Append(Wallpaper.Json(p.AlbumTitle));
        sb.Append(",\"status\":").Append(Wallpaper.Json(pb.PlaybackStatus.ToString()));
        sb.Append(",\"position\":").Append((long)tl.Position.TotalMilliseconds);
        sb.Append(",\"duration\":").Append((long)(tl.EndTime - tl.StartTime).TotalMilliseconds);
        sb.Append(",\"updated\":").Append(tl.LastUpdatedTime.ToUnixTimeMilliseconds());
        sb.Append(",\"canPrev\":").Append(c.IsPreviousEnabled ? "true" : "false");
        sb.Append(",\"canNext\":").Append(c.IsNextEnabled ? "true" : "false");
        sb.Append(",\"canSeek\":").Append(c.IsPlaybackPositionEnabled ? "true" : "false");
        sb.Append(",\"shuffle\":").Append(pb.IsShuffleActive.HasValue ? (pb.IsShuffleActive.Value ? "true" : "false") : "null");
        sb.Append(",\"repeat\":").Append(pb.AutoRepeatMode.HasValue ? Wallpaper.Json(pb.AutoRepeatMode.Value.ToString()) : "null");
        sb.Append(",\"art\":").Append(Wallpaper.Json(art));
        return sb.Append("}").ToString();
    }

    static string SaveArt(GlobalSystemMediaTransportControlsSessionMediaProperties p, string key)
    {
        if (p.Thumbnail == null || artDir == "") return "";
        try
        {
            string name;
            using (var sha = SHA1.Create()) name = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(key))).Replace("-", "").Substring(0, 20).ToLowerInvariant();
            var stream = p.Thumbnail.OpenReadAsync().Wait();
            string ext = (stream.ContentType ?? "").Contains("png") ? ".png" : ".jpg";
            string file = Path.Combine(artDir, name + ext);
            if (!File.Exists(file))
            {
                uint size = (uint)stream.Size;
                var reader = new DataReader(stream);
                reader.LoadAsync(size).Wait();
                var bytes = new byte[size];
                reader.ReadBytes(bytes);
                Directory.CreateDirectory(artDir);
                File.WriteAllBytes(file, bytes);
            }
            return file;
        }
        catch { return ""; }
    }

    /// <summary>target: "spotify" or "current"; cmd: play-pause, play, pause, next, prev, seek (ms), shuffle (0/1), repeat (None/Track/List).</summary>
    public static bool Command(string target, string cmd, string arg)
    {
        var m = Manager();
        var s = target == "spotify" ? Spotify(m) : m.GetCurrentSession();
        if (s == null) return false;
        switch (cmd)
        {
            case "play-pause": return s.TryTogglePlayPauseAsync().Wait();
            case "play": return s.TryPlayAsync().Wait();
            case "pause": return s.TryPauseAsync().Wait();
            case "next": return s.TrySkipNextAsync().Wait();
            case "prev": return s.TrySkipPreviousAsync().Wait();
            case "seek": return s.TryChangePlaybackPositionAsync(long.Parse(arg) * 10000).Wait();
            case "shuffle": return s.TryChangeShuffleActiveAsync(arg == "1").Wait();
            case "repeat":
                Windows.Media.MediaPlaybackAutoRepeatMode mode;
                if (!Enum.TryParse(arg, out mode)) return false;
                return s.TryChangeAutoRepeatModeAsync(mode).Wait();
        }
        return false;
    }
}
