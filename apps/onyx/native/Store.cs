// Where the replay buffer's video lives: encoded packets copied end to end into reusable 4 MB blocks, so
// minutes of video don't mean thousands of large allocations for the garbage collector to shuffle around.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace Onyx
{
    struct Entry
    {
        public long Offset;
        public int Length;
        public long Time, Duration;
        public bool Key;
    }

    /// <summary>Packets in arrival order. Not thread-safe: the recorder locks around it.</summary>
    sealed class PacketStore
    {
        const int BlockSize = 4 << 20;
        readonly List<byte[]> blocks = new List<byte[]>();
        readonly Stack<byte[]> spare = new Stack<byte[]>();
        long baseOffset; // stream offset of blocks[0][0]
        long end;        // where the next packet goes
        public readonly List<Entry> Entries = new List<Entry>();
        /// <summary>Saves in progress: while above zero, trimmed blocks are kept until they finish reading.</summary>
        public int Readers;
        public long Bytes { get { return Entries.Count == 0 ? 0 : end - Entries[0].Offset; } }

        public void Append(IntPtr data, int length, long time, long duration, bool key)
        {
            Entries.Add(new Entry { Offset = end, Length = length, Time = time, Duration = duration, Key = key });
            int done = 0;
            while (done < length)
            {
                long rel = end - baseOffset;
                int bi = (int)(rel / BlockSize), bo = (int)(rel % BlockSize);
                while (bi >= blocks.Count) blocks.Add(spare.Count > 0 ? spare.Pop() : new byte[BlockSize]);
                int n = Math.Min(length - done, BlockSize - bo);
                Marshal.Copy(new IntPtr(data.ToInt64() + done), blocks[bi], bo, n);
                done += n;
                end += n;
            }
        }

        /// <summary>Drops the first `count` packets and hands back the blocks nothing needs any more.</summary>
        public void RemoveFirst(int count)
        {
            if (count <= 0) return;
            Entries.RemoveRange(0, count);
            Release();
        }

        public void Release()
        {
            if (Readers > 0) return;
            long keep = Entries.Count > 0 ? Entries[0].Offset : end;
            while (blocks.Count > 0 && baseOffset + BlockSize <= keep)
            {
                // a couple of spare blocks cover the encoder's ups and downs; the rest go back to Windows
                if (spare.Count < 3) spare.Push(blocks[0]);
                blocks.RemoveAt(0);
                baseOffset += BlockSize;
            }
        }

        public void Clear()
        {
            Entries.Clear();
            blocks.Clear();
            spare.Clear();
            baseOffset = end;
        }

        /// <summary>Copies one packet into `dest` (at least e.Length long). The caller locks, and holds a reader
        /// (Readers) for the whole save so the blocks it still has to read aren't reused meanwhile.</summary>
        public void CopyTo(Entry e, byte[] dest)
        {
            long rel = e.Offset - baseOffset;
            int done = 0;
            while (done < e.Length)
            {
                int bi = (int)((rel + done) / BlockSize), bo = (int)((rel + done) % BlockSize);
                int n = Math.Min(e.Length - done, BlockSize - bo);
                Buffer.BlockCopy(blocks[bi], bo, dest, done, n);
                done += n;
            }
        }
    }
}
