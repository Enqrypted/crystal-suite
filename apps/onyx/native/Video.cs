// The video side of the replay buffer, all on the GPU: Windows.Graphics.Capture hands over each frame of the
// game window as a Direct3D texture, the Video Processor MFT converts it to NV12 at the chosen size, and the
// GPU's hardware H.264 encoder (NVENC, AMF or Quick Sync, through Media Foundation) compresses it. Only the
// compressed packets reach the CPU, which is why capturing barely touches the game's frame rate.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;

namespace Onyx
{
    /// <summary>A Direct3D 11 device on the GPU that drives the captured monitor, shared with Media Foundation.</summary>
    sealed class Gpu : IDisposable
    {
        public IntPtr Device;
        IntPtr context;
        public ID3D11Device D3D;
        public IMFDXGIDeviceManager Manager;
        public IntPtr ManagerUnk;
        public IDirect3DDevice WinRTDevice;
        public long Luid;
        public string Name = "";

        public Gpu(IntPtr monitor)
        {
            IntPtr adapter = FindAdapter(monitor, out Luid, out Name);
            int[] levels = { 0xb100, 0xb000 };
            int level;
            int hr = Dx.D3D11CreateDevice(adapter, adapter != IntPtr.Zero ? Dx.DRIVER_TYPE_UNKNOWN : Dx.DRIVER_TYPE_HARDWARE, IntPtr.Zero,
                Dx.CREATE_DEVICE_BGRA_SUPPORT | Dx.CREATE_DEVICE_VIDEO_SUPPORT, levels, levels.Length, Dx.SDK_VERSION, out Device, out level, out context);
            if (adapter != IntPtr.Zero) Marshal.Release(adapter);
            HR.Check(hr, "D3D11CreateDevice");
            D3D = (ID3D11Device)Marshal.GetObjectForIUnknown(Device);
            // Media Foundation uses the device from its own threads
            ((ID3D10Multithread)D3D).SetMultithreadProtected(1);
            // the GPU priority stays normal: lowered, Onyx's little work per frame can wait behind a game that keeps
            // the GPU busy, and Windows holds the next captured frame back until Onyx has read the last one
            int token;
            HR.Check(MFApi.MFCreateDXGIDeviceManager(out token, out Manager), "MFCreateDXGIDeviceManager");
            HR.Check(Manager.ResetDevice(Device, token), "ResetDevice");
            ManagerUnk = Marshal.GetIUnknownForObject(Manager);
            IntPtr dxgi;
            HR.Check(Marshal.QueryInterface(Device, ref G.IID_IDXGIDevice, out dxgi), "IDXGIDevice");
            IntPtr inspectable;
            try { HR.Check(Dx.CreateDirect3D11DeviceFromDXGIDevice(dxgi, out inspectable), "CreateDirect3D11DeviceFromDXGIDevice"); }
            finally { Marshal.Release(dxgi); }
            try { WinRTDevice = (IDirect3DDevice)Marshal.GetObjectForIUnknown(inspectable); }
            finally { Marshal.Release(inspectable); }
        }

        /// <summary>The adapter whose outputs include `monitor` (the default adapter when none does).</summary>
        static IntPtr FindAdapter(IntPtr monitor, out long luid, out string name)
        {
            luid = 0; name = "";
            IntPtr factoryPtr;
            if (Dx.CreateDXGIFactory1(ref G.IID_IDXGIFactory1, out factoryPtr) < 0) return IntPtr.Zero;
            var factory = (IDXGIFactory1)Marshal.GetObjectForIUnknown(factoryPtr);
            Marshal.Release(factoryPtr);
            IntPtr chosen = IntPtr.Zero, first = IntPtr.Zero;
            long firstLuid = 0; string firstName = "";
            try
            {
                for (int i = 0; chosen == IntPtr.Zero; i++)
                {
                    IntPtr ap;
                    if (factory.EnumAdapters1(i, out ap) < 0) break;
                    var adapter = (IDXGIAdapter1)Marshal.GetObjectForIUnknown(ap);
                    DXGI_ADAPTER_DESC1 desc;
                    adapter.GetDesc1(out desc);
                    bool software = (desc.Flags & 2) != 0;
                    bool match = false;
                    for (int j = 0; !match; j++)
                    {
                        IntPtr op;
                        if (adapter.EnumOutputs(j, out op) < 0) break;
                        var output = (IDXGIOutput)Marshal.GetObjectForIUnknown(op);
                        DXGI_OUTPUT_DESC od;
                        if (output.GetDesc(out od) >= 0 && od.Monitor == monitor) match = true;
                        Marshal.ReleaseComObject(output);
                        Marshal.Release(op);
                    }
                    Marshal.ReleaseComObject(adapter);
                    if (match && !software) { chosen = ap; luid = desc.AdapterLuid; name = desc.Description; }
                    else if (first == IntPtr.Zero && !software) { first = ap; firstLuid = desc.AdapterLuid; firstName = desc.Description; }
                    else Marshal.Release(ap);
                }
            }
            finally { Marshal.ReleaseComObject(factory); }
            if (chosen != IntPtr.Zero) { if (first != IntPtr.Zero) Marshal.Release(first); return chosen; }
            luid = firstLuid; name = firstName;
            return first;
        }

        public void Dispose()
        {
            if (WinRTDevice != null) { try { ((IDisposable)WinRTDevice).Dispose(); } catch { } Marshal.ReleaseComObject(WinRTDevice); WinRTDevice = null; }
            if (ManagerUnk != IntPtr.Zero) { Marshal.Release(ManagerUnk); ManagerUnk = IntPtr.Zero; }
            if (Manager != null) { Marshal.ReleaseComObject(Manager); Manager = null; }
            if (D3D != null) { Marshal.ReleaseComObject(D3D); D3D = null; }
            if (context != IntPtr.Zero) { Marshal.Release(context); context = IntPtr.Zero; }
            if (Device != IntPtr.Zero) { Marshal.Release(Device); Device = IntPtr.Zero; }
        }
    }

    static class MediaTypes
    {
        public static IMFMediaType Video(Guid subtype, int width, int height, int fps)
        {
            IMFMediaType t;
            HR.Check(MFApi.MFCreateMediaType(out t), "MFCreateMediaType");
            t.SetGUID(ref G.MF_MT_MAJOR_TYPE, ref G.MFMediaType_Video);
            t.SetGUID(ref G.MF_MT_SUBTYPE, ref subtype);
            t.SetUINT64(ref G.MF_MT_FRAME_SIZE, ((long)width << 32) | (uint)height);
            t.SetUINT64(ref G.MF_MT_FRAME_RATE, ((long)fps << 32) | 1);
            t.SetUINT64(ref G.MF_MT_PIXEL_ASPECT_RATIO, (1L << 32) | 1);
            t.SetUINT32(ref G.MF_MT_INTERLACE_MODE, 2);
            return t;
        }

        public static void Release(object o) { if (o != null && Marshal.IsComObject(o)) Marshal.ReleaseComObject(o); }
    }

    /// <summary>The Video Processor MFT: BGRA capture texture in, NV12 texture at the output size out (GPU only).</summary>
    sealed class Converter : IDisposable
    {
        IMFTransform t;
        IMFVideoProcessorControl control;
        readonly int outW, outH, fps;
        bool mftAllocates;
        readonly List<IMFSample> pool = new List<IMFSample>();
        readonly List<IntPtr> textures = new List<IntPtr>();
        int next;
        public const int PoolSize = 8;

        public Converter(Gpu gpu, int inW, int inH, int outW, int outH, int fps)
        {
            this.outW = outW; this.outH = outH; this.fps = fps;
            t = (IMFTransform)Activator.CreateInstance(Type.GetTypeFromCLSID(G.CLSID_VideoProcessorMFT));
            HR.Check(t.ProcessMessage(MFT.MESSAGE_SET_D3D_MANAGER, gpu.ManagerUnk), "video processor: D3D manager");
            control = t as IMFVideoProcessorControl;
            // one frame in, one frame out: no frame-rate conversion holding frames back
            IMFAttributes attrs;
            if (t.GetAttributes(out attrs) >= 0 && attrs != null) { attrs.SetUINT32(ref G.MF_XVP_DISABLE_FRC, 1); MediaTypes.Release(attrs); }
            var output = MediaTypes.Video(G.MFVideoFormat_NV12, outW, outH, fps);
            SetInput(inW, inH);
            HR.Check(t.SetOutputType(0, output, 0), "video processor: output type");
            MediaTypes.Release(output);
            MFT_OUTPUT_STREAM_INFO info;
            t.GetOutputStreamInfo(0, out info);
            mftAllocates = (info.dwFlags & MFT.OUTPUT_STREAM_PROVIDES_SAMPLES) != 0;
            if (Program.Debug) Console.WriteLine("video processor output flags 0x" + info.dwFlags.ToString("X") + " size " + info.cbSize);
            if (!mftAllocates)
            {
                // our own ring of NV12 textures for the encoder to read from
                var desc = new D3D11_TEXTURE2D_DESC { Width = outW, Height = outH, MipLevels = 1, ArraySize = 1, Format = Dx.DXGI_FORMAT_NV12, SampleCount = 1, BindFlags = Dx.BIND_RENDER_TARGET | Dx.BIND_VIDEO_ENCODER };
                for (int i = 0; i < PoolSize; i++)
                {
                    IntPtr tex;
                    int hr = gpu.D3D.CreateTexture2D(ref desc, IntPtr.Zero, out tex);
                    if (hr < 0 && desc.BindFlags != Dx.BIND_RENDER_TARGET) { desc.BindFlags = Dx.BIND_RENDER_TARGET; hr = gpu.D3D.CreateTexture2D(ref desc, IntPtr.Zero, out tex); }
                    HR.Check(hr, "CreateTexture2D NV12");
                    IMFMediaBuffer buffer;
                    HR.Check(MFApi.MFCreateDXGISurfaceBuffer(ref G.IID_ID3D11Texture2D, tex, 0, false, out buffer), "MFCreateDXGISurfaceBuffer");
                    IMFSample sample;
                    HR.Check(MFApi.MFCreateSample(out sample), "MFCreateSample");
                    sample.AddBuffer(buffer);
                    MediaTypes.Release(buffer);
                    pool.Add(sample);
                    textures.Add(tex);
                }
            }
            t.ProcessMessage(MFT.MESSAGE_NOTIFY_BEGIN_STREAMING, IntPtr.Zero);
            t.ProcessMessage(MFT.MESSAGE_NOTIFY_START_OF_STREAM, IntPtr.Zero);
        }

        public int InW { get; private set; }
        public int InH { get; private set; }

        public void SetInput(int inW, int inH)
        {
            var input = MediaTypes.Video(G.MFVideoFormat_ARGB32, inW, inH, fps);
            int hr = t.SetInputType(0, input, 0);
            MediaTypes.Release(input);
            HR.Check(hr, "video processor: input type");
            InW = inW; InH = inH;
        }

        /// <summary>The part of the captured frame to keep (the game's client area), in frame pixels.</summary>
        public void Crop(RECT r)
        {
            if (control != null) control.SetSourceRectangle(ref r);
        }

        /// <summary>Converts one frame; the returned sample is reused, so it must be encoded before PoolSize more frames.
        /// Null when the processor kept the frame back.</summary>
        public IMFSample Convert(IntPtr texture, long time, long duration)
        {
            IMFMediaBuffer buffer;
            HR.Check(MFApi.MFCreateDXGISurfaceBuffer(ref G.IID_ID3D11Texture2D, texture, 0, false, out buffer), "MFCreateDXGISurfaceBuffer");
            IMFSample input;
            MFApi.MFCreateSample(out input);
            input.AddBuffer(buffer);
            input.SetSampleTime(time);
            input.SetSampleDuration(duration);
            int hr = t.ProcessInput(0, input, 0);
            if (hr == HR.MF_E_NOTACCEPTING)
            {
                // an earlier frame is still inside; take it out and try again
                var stale = Pull();
                if (stale != null && mftAllocates) MediaTypes.Release(stale);
                hr = t.ProcessInput(0, input, 0);
            }
            MediaTypes.Release(input);
            MediaTypes.Release(buffer);
            HR.Check(hr, "video processor: ProcessInput");
            var result = Pull();
            if (result == null) return null;
            result.SetSampleTime(time);
            result.SetSampleDuration(duration);
            return result;
        }

        // the newest finished frame, or null when the processor wants more input
        IMFSample Pull()
        {
            IMFSample last = null;
            for (int i = 0; i < 4; i++)
            {
                var ob = new MFT_OUTPUT_DATA_BUFFER[1];
                IMFSample mine = null;
                if (!mftAllocates)
                {
                    mine = pool[next];
                    next = (next + 1) % pool.Count;
                    ob[0].pSample = Marshal.GetComInterfaceForObject(mine, typeof(IMFSample));
                }
                int status;
                int hr = t.ProcessOutput(0, 1, ob, out status);
                IMFSample result = mine;
                if (ob[0].pSample != IntPtr.Zero)
                {
                    if (mine == null && hr >= 0) result = (IMFSample)Marshal.GetObjectForIUnknown(ob[0].pSample);
                    Marshal.Release(ob[0].pSample);
                }
                if (ob[0].pEvents != IntPtr.Zero) Marshal.Release(ob[0].pEvents);
                if (Program.Debug && (hr < 0 || ob[0].dwStatus != 0 || status != 0 || i > 0)) Console.WriteLine("vp output #" + i + " hr 0x" + hr.ToString("X8") + " status 0x" + ob[0].dwStatus.ToString("X") + "/" + status);
                if (hr == HR.MF_E_TRANSFORM_NEED_MORE_INPUT) break;
                HR.Check(hr, "video processor: ProcessOutput");
                if (last != null && mftAllocates) MediaTypes.Release(last);
                last = result;
                if ((ob[0].dwStatus & MFT.OUTPUT_DATA_BUFFER_INCOMPLETE) == 0) break;
            }
            return last;
        }

        public bool OwnsSamples { get { return !mftAllocates; } }

        public void Dispose()
        {
            foreach (var s in pool) MediaTypes.Release(s);
            pool.Clear();
            foreach (var tex in textures) Marshal.Release(tex);
            textures.Clear();
            if (t != null) { try { t.ProcessMessage(MFT.MESSAGE_NOTIFY_END_STREAMING, IntPtr.Zero); } catch { } MediaTypes.Release(t); t = null; }
        }
    }

    /// <summary>The H.264 encoder: the GPU's hardware encoder when there is one (asynchronous MFT), else Windows' software one.</summary>
    sealed class VideoEncoder : IDisposable
    {
        public string Name = "";
        public bool Hardware;
        public byte[] SequenceHeader;
        public int InFlight { get { return Interlocked.CompareExchange(ref inFlight, 0, 0); } }
        /// <summary>An encoded packet (Annex B), valid only during the call.</summary>
        public Action<IntPtr, int, long, long, bool> OnPacket;
        public Action<string> OnError;

        IMFTransform t;
        IMFMediaEventGenerator events;
        ICodecAPI codec;
        bool async;
        readonly int fps;
        readonly BlockingCollection<IMFSample> queue = new BlockingCollection<IMFSample>(new ConcurrentQueue<IMFSample>());
        Thread thread;
        volatile bool running;
        int inFlight;
        long lastKeyTime = long.MinValue;
        long keyInterval;
        bool releaseInputs;

        public VideoEncoder(Gpu gpu, int width, int height, int fps, int kbps, bool releaseInputs)
        {
            this.fps = fps;
            this.releaseInputs = releaseInputs;
            keyInterval = 2 * 10000000L;
            t = Create(gpu.Luid, out Name, out Hardware);
            IMFAttributes attrs;
            if (t.GetAttributes(out attrs) >= 0 && attrs != null)
            {
                int a;
                async = attrs.GetUINT32(ref G.MF_TRANSFORM_ASYNC, out a) >= 0 && a != 0;
                if (async) attrs.SetUINT32(ref G.MF_TRANSFORM_ASYNC_UNLOCK, 1);
                attrs.SetUINT32(ref G.MF_LOW_LATENCY, 1);
                MediaTypes.Release(attrs);
            }
            if (Hardware) HR.Check(t.ProcessMessage(MFT.MESSAGE_SET_D3D_MANAGER, gpu.ManagerUnk), "encoder: D3D manager");
            else t.ProcessMessage(MFT.MESSAGE_SET_D3D_MANAGER, gpu.ManagerUnk);
            codec = t as ICodecAPI;
            Set(G.CODECAPI_AVEncCommonRateControlMode, (uint)1); // peak-constrained VBR
            Set(G.CODECAPI_AVEncCommonMeanBitRate, (uint)(kbps * 1000));
            Set(G.CODECAPI_AVEncCommonMaxBitRate, (uint)(kbps * 1500));
            Set(G.CODECAPI_AVEncMPVGOPSize, (uint)(fps * 2));
            Set(G.CODECAPI_AVEncMPVDefaultBPictureCount, (uint)0);
            Set(G.CODECAPI_AVLowLatencyMode, true);
            Set(G.CODECAPI_AVEncCommonQualityVsSpeed, (uint)50);

            var output = MediaTypes.Video(G.MFVideoFormat_H264, width, height, fps);
            output.SetUINT32(ref G.MF_MT_AVG_BITRATE, kbps * 1000);
            output.SetUINT32(ref G.MF_MT_MPEG2_PROFILE, 100); // High
            int hr = t.SetOutputType(0, output, 0);
            if (hr < 0) { output.SetUINT32(ref G.MF_MT_MPEG2_PROFILE, 77); hr = t.SetOutputType(0, output, 0); } // Main
            MediaTypes.Release(output);
            HR.Check(hr, "encoder: output type");
            var input = MediaTypes.Video(G.MFVideoFormat_NV12, width, height, fps);
            hr = t.SetInputType(0, input, 0);
            MediaTypes.Release(input);
            if (hr < 0)
            {
                // some encoders only take their own NV12 type object
                for (int i = 0; hr < 0; i++)
                {
                    IMFMediaType avail;
                    if (t.GetInputAvailableType(0, i, out avail) < 0) break;
                    Guid sub;
                    avail.GetGUID(ref G.MF_MT_SUBTYPE, out sub);
                    if (sub == G.MFVideoFormat_NV12)
                    {
                        avail.SetUINT64(ref G.MF_MT_FRAME_SIZE, ((long)width << 32) | (uint)height);
                        avail.SetUINT64(ref G.MF_MT_FRAME_RATE, ((long)fps << 32) | 1);
                        hr = t.SetInputType(0, avail, 0);
                    }
                    MediaTypes.Release(avail);
                }
            }
            HR.Check(hr, "encoder: input type");
            ReadSequenceHeader();
            HR.Check(t.ProcessMessage(MFT.MESSAGE_NOTIFY_BEGIN_STREAMING, IntPtr.Zero), "encoder: begin streaming");
            HR.Check(t.ProcessMessage(MFT.MESSAGE_NOTIFY_START_OF_STREAM, IntPtr.Zero), "encoder: start of stream");
            if (async) events = (IMFMediaEventGenerator)t;
            running = true;
            thread = new Thread(async ? (ThreadStart)AsyncLoop : SyncLoop);
            thread.IsBackground = true;
            thread.Name = "encoder";
            thread.Priority = ThreadPriority.AboveNormal;
            thread.Start();
        }

        void Set(Guid api, object value)
        {
            if (codec == null) return;
            try { codec.SetValue(ref api, ref value); } catch { }
        }

        void ReadSequenceHeader()
        {
            IMFMediaType current;
            if (t.GetOutputCurrentType(0, out current) < 0) return;
            int size;
            if (current.GetBlobSize(ref G.MF_MT_MPEG_SEQUENCE_HEADER, out size) >= 0 && size > 0)
            {
                var blob = new byte[size];
                int written;
                if (current.GetBlob(ref G.MF_MT_MPEG_SEQUENCE_HEADER, blob, size, out written) >= 0) SequenceHeader = blob;
            }
            MediaTypes.Release(current);
        }

        static IMFTransform Create(long luid, out string name, out bool hardware)
        {
            var input = new MFT_REGISTER_TYPE_INFO { guidMajorType = G.MFMediaType_Video, guidSubtype = G.MFVideoFormat_NV12 };
            var output = new MFT_REGISTER_TYPE_INFO { guidMajorType = G.MFMediaType_Video, guidSubtype = G.MFVideoFormat_H264 };
            name = ""; hardware = false;
            foreach (bool hw in new[] { true, false })
            {
                IntPtr array; int count;
                int flags = (hw ? MFT.ENUM_FLAG_HARDWARE : MFT.ENUM_FLAG_SYNCMFT) | MFT.ENUM_FLAG_SORTANDFILTER;
                int ehr = MFApi.MFTEnumEx(G.MFT_CATEGORY_VIDEO_ENCODER, flags, ref input, ref output, out array, out count);
                if (Program.Debug) Console.WriteLine("MFTEnumEx " + (hw ? "hardware" : "software") + " 0x" + ehr.ToString("X8") + " count " + count);
                if (ehr < 0 || count == 0) continue;
                var activates = new List<IMFActivate>();
                for (int i = 0; i < count; i++)
                {
                    IntPtr p = Marshal.ReadIntPtr(array, i * IntPtr.Size);
                    activates.Add((IMFActivate)Marshal.GetObjectForIUnknown(p));
                    Marshal.Release(p);
                }
                Marshal.FreeCoTaskMem(array);
                // the encoder on the capture GPU first; if that one won't start, the others in order
                var order = new List<IMFActivate>();
                if (hw) foreach (var a in activates) if (AdapterOf(a) == luid) order.Add(a);
                foreach (var a in activates) if (!order.Contains(a)) order.Add(a);
                IMFTransform transform = null;
                foreach (var a in order)
                {
                    IntPtr tp = IntPtr.Zero;
                    int hr = transform == null ? a.ActivateObject(ref G.IID_IMFTransform, out tp) : -1;
                    if (Program.Debug && transform == null) Console.WriteLine("encoder " + FriendlyName(a) + " adapter " + AdapterOf(a).ToString("X") + " (want " + luid.ToString("X") + ") activate 0x" + hr.ToString("X8"));
                    if (transform == null && hr >= 0)
                    {
                        transform = (IMFTransform)Marshal.GetObjectForIUnknown(tp);
                        Marshal.Release(tp);
                        name = FriendlyName(a);
                        hardware = hw;
                    }
                    else MediaTypes.Release(a);
                }
                if (transform != null) return transform;
            }
            throw new Exception("No H.264 encoder is available on this PC.");
        }

        // MFT_ENUM_ADAPTER_LUID is stored as an 8-byte LUID blob
        static long AdapterOf(IMFActivate a)
        {
            var b = new byte[8]; int written;
            if (a.GetBlob(ref G.MFT_ENUM_ADAPTER_LUID, b, 8, out written) < 0 || written != 8)
            {
                long l;
                return a.GetUINT64(ref G.MFT_ENUM_ADAPTER_LUID, out l) >= 0 ? l : 0;
            }
            return BitConverter.ToInt64(b, 0);
        }

        static string FriendlyName(IMFActivate a)
        {
            IntPtr s; int len;
            if (a.GetAllocatedString(ref G.MFT_FRIENDLY_NAME_Attribute, out s, out len) < 0) return "H.264 encoder";
            string name = Marshal.PtrToStringUni(s, len);
            Marshal.FreeCoTaskMem(s);
            return name;
        }

        /// <summary>Queues a converted frame. Frames are dropped by the caller while too many are in flight.</summary>
        public void Push(IMFSample sample)
        {
            Interlocked.Increment(ref inFlight);
            queue.Add(sample);
        }

        IMFSample Next()
        {
            IMFSample s;
            while (running) if (queue.TryTake(out s, 100)) return s;
            return null;
        }

        void Feed(IMFSample s)
        {
            long time;
            s.GetSampleTime(out time);
            if (time - lastKeyTime >= keyInterval)
            {
                Set(G.CODECAPI_AVEncVideoForceKeyFrame, (uint)1);
                lastKeyTime = time;
            }
            int hr = t.ProcessInput(0, s, 0);
            if (releaseInputs) MediaTypes.Release(s);
            if (hr < 0) { Interlocked.Decrement(ref inFlight); if (OnError != null) OnError("encoder input 0x" + hr.ToString("X8")); }
        }

        void AsyncLoop()
        {
            try
            {
                while (running)
                {
                    IMFMediaEvent ev;
                    int hr = events.GetEvent(0, out ev);
                    if (hr < 0) break;
                    int type;
                    ev.GetEventType(out type);
                    MediaTypes.Release(ev);
                    if (type == MFT.METransformNeedInput)
                    {
                        var s = Next();
                        if (s == null) break;
                        Feed(s);
                    }
                    else if (type == MFT.METransformHaveOutput) Drain(true);
                }
            }
            catch (Exception e) { if (running && OnError != null) OnError(e.Message); }
        }

        void SyncLoop()
        {
            try
            {
                while (running)
                {
                    var s = Next();
                    if (s == null) break;
                    Feed(s);
                    while (Drain(false)) { }
                }
            }
            catch (Exception e) { if (running && OnError != null) OnError(e.Message); }
        }

        /// <summary>Takes one encoded packet out of the encoder; false when it has none.</summary>
        bool Drain(bool single)
        {
            MFT_OUTPUT_STREAM_INFO info;
            t.GetOutputStreamInfo(0, out info);
            bool mftAllocates = (info.dwFlags & (MFT.OUTPUT_STREAM_PROVIDES_SAMPLES | MFT.OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;
            var ob = new MFT_OUTPUT_DATA_BUFFER[1];
            IMFSample mine = null;
            if (!mftAllocates)
            {
                IMFMediaBuffer buf;
                MFApi.MFCreateMemoryBuffer(Math.Max(info.cbSize, 1 << 20), out buf);
                MFApi.MFCreateSample(out mine);
                mine.AddBuffer(buf);
                MediaTypes.Release(buf);
                ob[0].pSample = Marshal.GetComInterfaceForObject(mine, typeof(IMFSample));
            }
            int status;
            int hr = t.ProcessOutput(0, 1, ob, out status);
            IMFSample sample = mine;
            if (ob[0].pSample != IntPtr.Zero)
            {
                if (mine == null) sample = (IMFSample)Marshal.GetObjectForIUnknown(ob[0].pSample);
                Marshal.Release(ob[0].pSample);
            }
            if (ob[0].pEvents != IntPtr.Zero) Marshal.Release(ob[0].pEvents);
            if (hr == HR.MF_E_TRANSFORM_STREAM_CHANGE)
            {
                IMFMediaType type;
                if (t.GetOutputAvailableType(0, 0, out type) >= 0) { t.SetOutputType(0, type, 0); MediaTypes.Release(type); }
                ReadSequenceHeader();
                MediaTypes.Release(sample);
                return true;
            }
            if (hr == HR.MF_E_TRANSFORM_NEED_MORE_INPUT || hr < 0) { MediaTypes.Release(sample); return false; }
            Interlocked.Decrement(ref inFlight);
            long time, duration;
            sample.GetSampleTime(out time);
            if (sample.GetSampleDuration(out duration) < 0) duration = 10000000L / fps;
            int clean;
            bool key = sample.GetUINT32(ref G.MFSampleExtension_CleanPoint, out clean) >= 0 && clean != 0;
            IMFMediaBuffer contiguous;
            if (sample.ConvertToContiguousBuffer(out contiguous) >= 0)
            {
                IntPtr p; int max, len;
                if (contiguous.Lock(out p, out max, out len) >= 0)
                {
                    try { if (OnPacket != null && len > 0) OnPacket(p, len, time, duration, key); }
                    finally { contiguous.Unlock(); }
                }
                MediaTypes.Release(contiguous);
            }
            MediaTypes.Release(sample);
            return !single;
        }

        public void Dispose()
        {
            running = false;
            var shutdown = t as IMFShutdown;
            if (shutdown != null) { try { shutdown.Shutdown(); } catch { } }
            if (thread != null) thread.Join(2000);
            IMFSample s;
            while (queue.TryTake(out s)) if (releaseInputs) MediaTypes.Release(s);
            if (t != null) { try { t.ProcessMessage(MFT.MESSAGE_NOTIFY_END_STREAMING, IntPtr.Zero); } catch { } MediaTypes.Release(t); t = null; }
        }
    }

    /// <summary>Captures a window (or a monitor) and feeds its frames, paced to the chosen frame rate, to the encoder.</summary>
    sealed class Capture : IDisposable
    {
        public readonly Gpu Gpu;
        public int Width, Height;
        public int Fps, Kbps;
        public long Frames, Dropped;
        public Action<string> OnStopped;
        public VideoEncoder Encoder;

        readonly IntPtr hwnd;
        readonly bool monitor;
        readonly IntPtr watch;
        int aliveCheck;
        GraphicsCaptureItem item;
        Direct3D11CaptureFramePool pool;
        GraphicsCaptureSession session;
        Converter converter;
        SizeInt32 poolSize;
        Thread thread;
        volatile bool running;
        readonly long t0;
        readonly int maxHeight;

        public Capture(IntPtr target, bool isMonitor, IntPtr watch, int fps, int maxHeight, int quality, long t0, Action<IntPtr, int, long, long, bool> onPacket, Action<string> onError)
        {
            hwnd = target; monitor = isMonitor; this.watch = watch; Fps = fps; this.t0 = t0; this.maxHeight = maxHeight;
            Gpu = new Gpu(isMonitor ? target : Win32.MonitorFromWindow(target, Win32.MONITOR_DEFAULTTONEAREST));
            try
            {
                item = CreateItem(target, isMonitor);
                poolSize = item.Size;
                if (poolSize.Width < 16 || poolSize.Height < 16) throw new Exception("The window is too small to record.");
                RECT crop = Crop(poolSize);
                int srcW = crop.Right - crop.Left, srcH = crop.Bottom - crop.Top;
                // the output keeps the game's shape: its height is capped by the chosen resolution, never enlarged
                double scale = maxHeight > 0 && maxHeight < srcH ? maxHeight / (double)srcH : 1;
                // H.264 encoders stop at 4096 x 2304: wider sources (a 32:9 monitor, say) are scaled to fit
                scale = Math.Min(scale, Math.Min(MaxWidth / (double)srcW, MaxHeight / (double)srcH));
                Width = Math.Max(16, (int)Math.Round(srcW * scale) & ~1); Height = Math.Max(16, (int)Math.Round(srcH * scale) & ~1);
                int kbps = Bitrate(Width, Height, fps, quality);
                Kbps = kbps;
                converter = new Converter(Gpu, poolSize.Width, poolSize.Height, Width, Height, fps);
                converter.Crop(crop);
                Encoder = new VideoEncoder(Gpu, Width, Height, fps, kbps, !converter.OwnsSamples);
                Encoder.OnPacket = onPacket;
                Encoder.OnError = onError;
                pool = Direct3D11CaptureFramePool.CreateFreeThreaded(Gpu.WinRTDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, poolSize);
                session = pool.CreateCaptureSession(item);
                try { session.IsCursorCaptureEnabled = false; } catch { }
                try { session.IsBorderRequired = false; } catch { }
                // a little under the frame interval, so the game's frames land in every output slot
                try { session.MinUpdateInterval = TimeSpan.FromTicks(10000000L / fps * 3 / 4); } catch { }
                session.StartCapture();
            }
            catch { Dispose(); throw; }
            running = true;
            thread = new Thread(Loop);
            thread.IsBackground = true;
            thread.Name = "capture";
            thread.Priority = ThreadPriority.AboveNormal;
            thread.Start();
        }

        public const int MaxWidth = 4096, MaxHeight = 2304;

        /// <summary>Kilobits per second for a size and frame rate; quality 0 = standard, 1 = high, 2 = ultra.
        /// (1080p60: about 8, 12 and 17 Mbit/s; capped at 50, which keeps two minutes under 400 MB.)</summary>
        public static int Bitrate(int w, int h, int fps, int quality)
        {
            double bpp = quality <= 0 ? 0.065 : quality == 1 ? 0.095 : 0.14;
            return (int)Math.Max(2000, Math.Min(50000, w * (double)h * fps * bpp / 1000));
        }

        static GraphicsCaptureItem CreateItem(IntPtr target, bool isMonitor)
        {
            var interop = (IGraphicsCaptureItemInterop)WinRT.Factory("Windows.Graphics.Capture.GraphicsCaptureItem", G.IID_IGraphicsCaptureItemInterop);
            IntPtr p;
            try
            {
                int hr = isMonitor ? interop.CreateForMonitor(target, ref G.IID_IGraphicsCaptureItem, out p) : interop.CreateForWindow(target, ref G.IID_IGraphicsCaptureItem, out p);
                HR.Check(hr, isMonitor ? "capture monitor" : "capture window");
            }
            finally { Marshal.ReleaseComObject(interop); }
            try { return (GraphicsCaptureItem)Marshal.GetObjectForIUnknown(p); }
            finally { Marshal.Release(p); }
        }

        /// <summary>For a window, its client area within the captured frame (windowed games without their title bar).</summary>
        RECT Crop(SizeInt32 frame)
        {
            var full = new RECT { Left = 0, Top = 0, Right = frame.Width, Bottom = frame.Height };
            if (monitor) return full;
            RECT bounds, client;
            if (Win32.DwmGetWindowAttribute(hwnd, Win32.DWMWA_EXTENDED_FRAME_BOUNDS, out bounds, Marshal.SizeOf(typeof(RECT))) != 0) return full;
            if (!Win32.GetClientRect(hwnd, out client)) return full;
            var origin = new POINT();
            Win32.ClientToScreen(hwnd, ref origin);
            var r = new RECT
            {
                Left = Math.Max(0, origin.X - bounds.Left),
                Top = Math.Max(0, origin.Y - bounds.Top),
            };
            r.Right = Math.Min(frame.Width, r.Left + client.Right);
            r.Bottom = Math.Min(frame.Height, r.Top + client.Bottom);
            if (r.Right - r.Left < 16 || r.Bottom - r.Top < 16) return full;
            return r;
        }

        void Loop()
        {
            long interval = 10000000L / Fps;
            long lastSlot = long.MinValue;
            try
            {
                while (running)
                {
                    // the window is gone (or, for a screen recorded in place of a game's window, that game)
                    if (Environment.TickCount - aliveCheck > 500)
                    {
                        aliveCheck = Environment.TickCount;
                        if ((!monitor && !Win32.IsWindow(hwnd)) || (watch != IntPtr.Zero && !Win32.IsWindow(watch))) { Stop("closed"); return; }
                    }
                    Direct3D11CaptureFrame frame = null, f;
                    while ((f = pool.TryGetNextFrame()) != null) { if (frame != null) frame.Dispose(); frame = f; }
                    if (frame == null)
                    {
                        Thread.Sleep(1);
                        continue;
                    }
                    long time = frame.SystemRelativeTime.Ticks - t0;
                    long slot = time / interval;
                    if (slot <= lastSlot) { frame.Dispose(); continue; }
                    lastSlot = slot;
                    var size = frame.ContentSize;
                    if (size.Width != poolSize.Width || size.Height != poolSize.Height)
                    {
                        // the game changed size: the frames and the converter follow; the output size stays
                        frame.Dispose();
                        if (size.Width < 16 || size.Height < 16) continue;
                        poolSize = size;
                        pool.Recreate(Gpu.WinRTDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, size);
                        converter.SetInput(size.Width, size.Height);
                        converter.Crop(Crop(size));
                        continue;
                    }
                    if (Encoder.InFlight >= Converter.PoolSize - 3) { Dropped++; frame.Dispose(); continue; }
                    var surface = frame.Surface;
                    IntPtr texture = IntPtr.Zero;
                    try
                    {
                        HR.Check(((IDirect3DDxgiInterfaceAccess)(object)surface).GetInterface(ref G.IID_ID3D11Texture2D, out texture), "frame texture");
                        var sample = converter.Convert(texture, time, interval);
                        if (sample != null) { Encoder.Push(sample); Frames++; }
                    }
                    finally
                    {
                        if (texture != IntPtr.Zero) Marshal.Release(texture);
                        MediaTypes.Release(surface);
                        frame.Dispose();
                    }
                }
            }
            catch (Exception e) { if (running) Stop(Program.Debug ? e.ToString() : e.Message); }
        }

        void Stop(string why)
        {
            running = false;
            if (OnStopped != null) OnStopped(why);
        }

        public void Dispose()
        {
            running = false;
            if (thread != null && Thread.CurrentThread != thread) thread.Join(2000);
            if (session != null) { try { session.Dispose(); } catch { } session = null; }
            if (pool != null) { try { pool.Dispose(); } catch { } pool = null; }
            if (Encoder != null) { Encoder.Dispose(); Encoder = null; }
            if (converter != null) { converter.Dispose(); converter = null; }
            if (item != null) { MediaTypes.Release(item); item = null; }
            Gpu.Dispose();
        }
    }
}
