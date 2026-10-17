// The audio side of the replay buffer: what the PC plays (WASAPI loopback, so the game and everything else you
// hear) and, if chosen, the microphone. Both are placed on one 48 kHz timeline by their capture timestamps
// (the clock the video frames use too), mixed, and encoded to AAC by Windows' AAC encoder in small blocks.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace Onyx
{
    /// <summary>Sums the sources on a 48 kHz stereo timeline that starts at t0.</summary>
    sealed class Mixer
    {
        public const int Rate = 48000;
        const int Size = Rate * 8;
        readonly float[] ring = new float[Size * 2];
        readonly long[] cursor = { -1, -1 };
        readonly object gate = new object();
        readonly long t0;
        public long ReadPos;

        public Mixer(long t0, long startFrame) { this.t0 = t0; ReadPos = startFrame; }

        public long FrameAt(long time100ns) { return (time100ns - t0) * Rate / 10000000L; }

        /// <summary>Adds `frames` stereo frames (already 48 kHz) from a source captured at `qpc`.</summary>
        public void Write(int source, float[] data, int frames, long qpc)
        {
            long expected = FrameAt(qpc);
            lock (gate)
            {
                // follow the source's own pace; jump to its timestamp only when it drifts or resumes after a pause
                if (cursor[source] < 0 || Math.Abs(expected - cursor[source]) > Rate / 40) cursor[source] = expected;
                long pos = cursor[source];
                cursor[source] += frames;
                int skip = 0;
                if (pos < ReadPos) skip = (int)Math.Min(frames, ReadPos - pos);
                if (pos + frames > ReadPos + Size) return; // far ahead of the encoder: drop rather than wrap
                for (int i = skip; i < frames; i++)
                {
                    int idx = (int)((pos + i) % Size) * 2;
                    ring[idx] += data[i * 2];
                    ring[idx + 1] += data[i * 2 + 1];
                }
            }
        }

        /// <summary>Takes the next block of `frames` once everything up to `upTo` has had time to arrive.</summary>
        public bool Read(short[] block, int frames, long upTo)
        {
            lock (gate)
            {
                if (ReadPos + frames > upTo) return false;
                for (int i = 0; i < frames; i++)
                {
                    int idx = (int)((ReadPos + i) % Size) * 2;
                    block[i * 2] = Clip(ring[idx]);
                    block[i * 2 + 1] = Clip(ring[idx + 1]);
                    ring[idx] = 0; ring[idx + 1] = 0;
                }
                ReadPos += frames;
                return true;
            }
        }

        static short Clip(float v)
        {
            int s = (int)Math.Round(v * 32767f);
            return (short)(s > 32767 ? 32767 : s < -32768 ? -32768 : s);
        }
    }

    /// <summary>One WASAPI capture stream, converted to 48 kHz stereo float for the mixer.</summary>
    sealed class AudioSource : IDisposable
    {
        IAudioClient client;
        IAudioCaptureClient capture;
        readonly Mixer mixer;
        readonly int id;
        int channels, rate, bits, block;
        bool isFloat;
        Thread thread;
        volatile bool running;
        double phase; // resampler position between input frames
        float lastL, lastR;
        float[] scratch = new float[0], output = new float[0];
        public string Error;

        public AudioSource(bool loopback, Mixer mixer, int id)
        {
            this.mixer = mixer; this.id = id;
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            IMMDevice device;
            HR.Check(enumerator.GetDefaultAudioEndpoint(loopback ? 0 : 1, 0, out device), loopback ? "no audio output device" : "no microphone");
            object o;
            HR.Check(device.Activate(ref G.IID_IAudioClient, 23, IntPtr.Zero, out o), "audio device");
            client = (IAudioClient)o;
            IntPtr format;
            HR.Check(client.GetMixFormat(out format), "audio format");
            try
            {
                int tag = Marshal.ReadInt16(format, 0) & 0xffff;
                channels = Marshal.ReadInt16(format, 2);
                rate = Marshal.ReadInt32(format, 4);
                block = Marshal.ReadInt16(format, 12);
                bits = Marshal.ReadInt16(format, 14);
                isFloat = tag == 3;
                if (tag == 0xFFFE)
                {
                    var sub = (Guid)Marshal.PtrToStructure(new IntPtr(format.ToInt64() + 24), typeof(Guid));
                    isFloat = sub == G.KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
                }
                HR.Check(client.Initialize(0, loopback ? 0x20000 : 0, 2000000, 0, format, IntPtr.Zero), "audio start");
            }
            finally { Marshal.FreeCoTaskMem(format); }
            object c;
            HR.Check(client.GetService(ref G.IID_IAudioCaptureClient, out c), "audio capture");
            capture = (IAudioCaptureClient)c;
            MediaTypes.Release(device);
            MediaTypes.Release(enumerator);
            HR.Check(client.Start(), "audio start");
            running = true;
            thread = new Thread(Loop);
            thread.IsBackground = true;
            thread.Name = loopback ? "loopback" : "microphone";
            thread.Start();
        }

        void Loop()
        {
            try
            {
                while (running)
                {
                    Thread.Sleep(5);
                    int next;
                    while (running && capture.GetNextPacketSize(out next) >= 0 && next > 0)
                    {
                        IntPtr data; int frames, flags; long devicePos, qpc;
                        int hr = capture.GetBuffer(out data, out frames, out flags, out devicePos, out qpc);
                        if (hr < 0) throw new COMException("audio read", hr);
                        if (frames > 0) Deliver(data, frames, (flags & 2) != 0, qpc);
                        capture.ReleaseBuffer(frames);
                    }
                }
            }
            catch (Exception e) { Error = e.Message; }
        }

        /// <summary>Converts a packet to stereo float, resamples it to 48 kHz and hands it to the mixer.</summary>
        void Deliver(IntPtr data, int frames, bool silent, long qpc)
        {
            if (scratch.Length < frames * 2) scratch = new float[frames * 2];
            if (silent) Array.Clear(scratch, 0, frames * 2);
            else
            {
                var raw = new byte[frames * block];
                Marshal.Copy(data, raw, 0, raw.Length);
                for (int f = 0; f < frames; f++)
                {
                    int o = f * block;
                    float l = Sample(raw, o, 0), r = channels > 1 ? Sample(raw, o, 1) : l;
                    if (channels > 2) { float c = Sample(raw, o, 2) * 0.7f; l += c; r += c; }
                    scratch[f * 2] = l; scratch[f * 2 + 1] = r;
                }
            }
            if (rate == Mixer.Rate) { mixer.Write(id, scratch, frames, qpc); return; }
            // linear resampling to 48 kHz, continuous across packets
            // `phase` is where the next output frame falls, in input frames of this packet (-1 = the previous
            // packet's last frame)
            double step = rate / (double)Mixer.Rate;
            int max = (int)(frames / step) + 3;
            if (output.Length < max * 2) output = new float[max * 2];
            int n = 0;
            while (phase <= frames - 1)
            {
                int i = (int)Math.Floor(phase);
                double frac = phase - i;
                float l0 = i < 0 ? lastL : scratch[i * 2], r0 = i < 0 ? lastR : scratch[i * 2 + 1];
                float l1 = l0, r1 = r0;
                if (i + 1 < frames) { l1 = scratch[(i + 1) * 2]; r1 = scratch[(i + 1) * 2 + 1]; }
                output[n * 2] = (float)(l0 + (l1 - l0) * frac);
                output[n * 2 + 1] = (float)(r0 + (r1 - r0) * frac);
                n++;
                phase += step;
            }
            phase -= frames;
            lastL = scratch[(frames - 1) * 2]; lastR = scratch[(frames - 1) * 2 + 1];
            mixer.Write(id, output, n, qpc);
        }

        float Sample(byte[] raw, int frameOffset, int ch)
        {
            int bytes = bits / 8;
            int o = frameOffset + ch * bytes;
            if (isFloat) return BitConverter.ToSingle(raw, o);
            if (bits == 16) return BitConverter.ToInt16(raw, o) / 32768f;
            if (bits == 24) return ((raw[o] << 8 | raw[o + 1] << 16 | raw[o + 2] << 24) >> 8) / 8388608f;
            if (bits == 32) return BitConverter.ToInt32(raw, o) / 2147483648f;
            return 0;
        }

        public void Dispose()
        {
            running = false;
            if (thread != null) thread.Join(1000);
            if (client != null) { try { client.Stop(); } catch { } }
            MediaTypes.Release(capture); capture = null;
            MediaTypes.Release(client); client = null;
        }
    }

    /// <summary>Windows' AAC encoder (synchronous MFT): 16-bit 48 kHz stereo PCM in, raw AAC-LC frames out.</summary>
    sealed class AacEncoder : IDisposable
    {
        IMFTransform t;
        public byte[] Config = { 0x11, 0x90 }; // AudioSpecificConfig: AAC-LC, 48 kHz, stereo
        int outSize;

        public AacEncoder(int kbps)
        {
            t = (IMFTransform)Activator.CreateInstance(Type.GetTypeFromCLSID(G.CLSID_AACMFTEncoder));
            IMFMediaType input;
            MFApi.MFCreateMediaType(out input);
            input.SetGUID(ref G.MF_MT_MAJOR_TYPE, ref G.MFMediaType_Audio);
            input.SetGUID(ref G.MF_MT_SUBTYPE, ref G.MFAudioFormat_PCM);
            input.SetUINT32(ref G.MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
            input.SetUINT32(ref G.MF_MT_AUDIO_SAMPLES_PER_SECOND, Mixer.Rate);
            input.SetUINT32(ref G.MF_MT_AUDIO_NUM_CHANNELS, 2);
            input.SetUINT32(ref G.MF_MT_AUDIO_BLOCK_ALIGNMENT, 4);
            input.SetUINT32(ref G.MF_MT_AUDIO_AVG_BYTES_PER_SECOND, Mixer.Rate * 4);
            IMFMediaType output;
            MFApi.MFCreateMediaType(out output);
            output.SetGUID(ref G.MF_MT_MAJOR_TYPE, ref G.MFMediaType_Audio);
            output.SetGUID(ref G.MF_MT_SUBTYPE, ref G.MFAudioFormat_AAC);
            output.SetUINT32(ref G.MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
            output.SetUINT32(ref G.MF_MT_AUDIO_SAMPLES_PER_SECOND, Mixer.Rate);
            output.SetUINT32(ref G.MF_MT_AUDIO_NUM_CHANNELS, 2);
            output.SetUINT32(ref G.MF_MT_AUDIO_AVG_BYTES_PER_SECOND, kbps >= 190 ? 24000 : kbps >= 150 ? 20000 : 16000);
            output.SetUINT32(ref G.MF_MT_AAC_PAYLOAD_TYPE, 0);
            int hr = t.SetInputType(0, input, 0);
            if (hr >= 0) hr = t.SetOutputType(0, output, 0);
            else { HR.Check(t.SetOutputType(0, output, 0), "AAC output type"); hr = t.SetInputType(0, input, 0); }
            MediaTypes.Release(input);
            MediaTypes.Release(output);
            HR.Check(hr, "AAC encoder types");
            IMFMediaType current;
            if (t.GetOutputCurrentType(0, out current) >= 0)
            {
                int size;
                if (current.GetBlobSize(ref G.MF_MT_USER_DATA, out size) >= 0 && size > 12)
                {
                    var blob = new byte[size];
                    int written;
                    current.GetBlob(ref G.MF_MT_USER_DATA, blob, size, out written);
                    Config = new byte[size - 12];
                    Array.Copy(blob, 12, Config, 0, Config.Length);
                }
                MediaTypes.Release(current);
            }
            MFT_OUTPUT_STREAM_INFO info;
            t.GetOutputStreamInfo(0, out info);
            outSize = Math.Max(info.cbSize, 8192);
            t.ProcessMessage(MFT.MESSAGE_NOTIFY_BEGIN_STREAMING, IntPtr.Zero);
            t.ProcessMessage(MFT.MESSAGE_NOTIFY_START_OF_STREAM, IntPtr.Zero);
        }

        public void Encode(short[] pcm, int frames, long time, Action<byte[], long, long> onPacket)
        {
            IMFMediaBuffer buffer;
            MFApi.MFCreateMemoryBuffer(frames * 4, out buffer);
            IntPtr p; int max, cur;
            buffer.Lock(out p, out max, out cur);
            Marshal.Copy(pcm, 0, p, frames * 2);
            buffer.Unlock();
            buffer.SetCurrentLength(frames * 4);
            IMFSample sample;
            MFApi.MFCreateSample(out sample);
            sample.AddBuffer(buffer);
            sample.SetSampleTime(time);
            sample.SetSampleDuration(frames * 10000000L / Mixer.Rate);
            int hr = t.ProcessInput(0, sample, 0);
            MediaTypes.Release(sample);
            MediaTypes.Release(buffer);
            HR.Check(hr, "AAC encode");
            for (; ; )
            {
                IMFMediaBuffer ob;
                MFApi.MFCreateMemoryBuffer(outSize, out ob);
                IMFSample os;
                MFApi.MFCreateSample(out os);
                os.AddBuffer(ob);
                var data = new MFT_OUTPUT_DATA_BUFFER[1];
                data[0].pSample = Marshal.GetComInterfaceForObject(os, typeof(IMFSample));
                int status;
                hr = t.ProcessOutput(0, 1, data, out status);
                Marshal.Release(data[0].pSample);
                if (data[0].pEvents != IntPtr.Zero) Marshal.Release(data[0].pEvents);
                if (hr >= 0)
                {
                    long ts, dur;
                    os.GetSampleTime(out ts);
                    if (os.GetSampleDuration(out dur) < 0) dur = 1024 * 10000000L / Mixer.Rate;
                    IntPtr q; int m, len;
                    ob.Lock(out q, out m, out len);
                    var bytes = new byte[len];
                    Marshal.Copy(q, bytes, 0, len);
                    ob.Unlock();
                    if (len > 0) onPacket(bytes, ts, dur);
                }
                MediaTypes.Release(os);
                MediaTypes.Release(ob);
                if (hr < 0) break;
            }
        }

        public void Dispose() { MediaTypes.Release(t); t = null; }
    }

    /// <summary>The sound for every recording: captured and encoded once, and only while a recording listens.</summary>
    sealed class AudioHub : IDisposable
    {
        readonly long t0;
        readonly object gate = new object();
        volatile Action<byte[], long, long>[] listeners = new Action<byte[], long, long>[0];
        AudioCapture capture;
        bool system = true, mic;
        string problem = "";
        /// <summary>AudioSpecificConfig of the AAC packets.</summary>
        public byte[] Config = { 0x11, 0x90 };

        public AudioHub(long t0) { this.t0 = t0; }

        public string Problem { get { var c = capture; return c != null ? c.Problem : problem; } }

        public void Configure(bool system, bool mic)
        {
            lock (gate)
            {
                if (this.system == system && this.mic == mic) return;
                this.system = system; this.mic = mic;
                Restart();
            }
        }

        public void Subscribe(Action<byte[], long, long> listener)
        {
            lock (gate)
            {
                var list = new List<Action<byte[], long, long>>(listeners);
                list.Add(listener);
                listeners = list.ToArray();
                if (capture == null) Restart();
            }
        }

        public void Unsubscribe(Action<byte[], long, long> listener)
        {
            lock (gate)
            {
                var list = new List<Action<byte[], long, long>>(listeners);
                list.Remove(listener);
                listeners = list.ToArray();
                if (listeners.Length == 0) Stop();
            }
        }

        void Restart()
        {
            Stop();
            problem = "";
            if (listeners.Length == 0 || (!system && !mic)) return;
            try { capture = new AudioCapture(system, mic, t0, Dispatch); Config = capture.Config; }
            catch (Exception e) { problem = "Sound: " + e.Message; }
        }

        void Stop()
        {
            if (capture == null) return;
            capture.Dispose();
            capture = null;
        }

        void Dispatch(byte[] data, long time, long duration)
        {
            foreach (var l in listeners) l(data, time, duration);
        }

        public void Dispose()
        {
            lock (gate) { listeners = new Action<byte[], long, long>[0]; Stop(); }
        }
    }

    /// <summary>System sound and/or the microphone, mixed and encoded; packets go to `onPacket`.</summary>
    sealed class AudioCapture : IDisposable
    {
        readonly Mixer mixer;
        AudioSource system, mic;
        readonly AacEncoder aac;
        readonly Thread thread;
        volatile bool running;
        readonly Action<byte[], long, long> onPacket;
        public byte[] Config { get { return aac.Config; } }
        public string Problem = "";

        public AudioCapture(bool withSystem, bool withMic, long t0, Action<byte[], long, long> onPacket)
        {
            this.onPacket = onPacket;
            mixer = new Mixer(t0, 0);
            mixer.ReadPos = mixer.FrameAt(Win32.Now100ns());
            aac = new AacEncoder(160);
            if (withSystem) { try { system = new AudioSource(true, mixer, 0); } catch (Exception e) { Problem = "System sound: " + e.Message; } }
            if (withMic) { try { mic = new AudioSource(false, mixer, 1); } catch (Exception e) { Problem = "Microphone: " + e.Message; } }
            running = true;
            thread = new Thread(Loop);
            thread.IsBackground = true;
            thread.Name = "audio encoder";
            thread.Start();
        }

        void Loop()
        {
            const int frames = 1024;
            var block = new short[frames * 2];
            try
            {
                while (running)
                {
                    Thread.Sleep(15);
                    // a 150 ms margin lets late packets (and the microphone) land before a block is encoded
                    long upTo = mixer.FrameAt(Win32.Now100ns()) - Mixer.Rate * 15 / 100;
                    long start = mixer.ReadPos;
                    while (running && mixer.Read(block, frames, upTo))
                    {
                        aac.Encode(block, frames, start * 10000000L / Mixer.Rate, onPacket);
                        start = mixer.ReadPos;
                    }
                }
            }
            catch (Exception e) { Problem = "Audio: " + (Program.Debug ? e.ToString() : e.Message); }
        }

        public void Dispose()
        {
            running = false;
            thread.Join(1000);
            if (system != null) system.Dispose();
            if (mic != null) mic.Dispose();
            aac.Dispose();
        }
    }
}
