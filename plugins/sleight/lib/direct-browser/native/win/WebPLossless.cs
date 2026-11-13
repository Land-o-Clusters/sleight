// Independent managed implementation of the WebP lossless bitstream contract:
// https://developers.google.com/speed/webp/docs/webp_lossless_bitstream_specification
// No OS image codec is called. All image, tree, recursion and work sizes are bounded.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace Sleight.Cursor
{
public sealed class WebPLossless
{
    readonly byte[] data;
    readonly int end;
    int bit, work, cells;
    readonly Func<bool> cancelled;
    readonly Stopwatch clock = Stopwatch.StartNew();
    WebPLossless(byte[] data, int at, int length, Func<bool> cancelled)
    {
        this.data = data; bit = at * 8; end = (at + length) * 8; this.cancelled = cancelled;
    }
    void Check()
    {
        if (++work > 64000000 || (work & 4095) == 0 &&
            (clock.ElapsedMilliseconds > 2000 || cancelled != null && cancelled()))
            throw new IOException("decode");
    }
    void Reserve(int count)
    {
        if (count < 0 || (cells += count) > 16000000) throw new IOException("size");
    }
    int Read(int n)
    {
        Check();
        if (n < 0 || n > 24 || bit > end - n) throw new IOException("decode");
        int value = 0;
        for (int i = 0; i < n; i++, bit++) value |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
        return value;
    }
    sealed class Code
    {
        readonly int[] zero, one;
        readonly int single = -1;
        public Code(int[] lengths)
        {
            int[] counts = new int[16], next = new int[16];
            int used = 0;
            for (int i = 0; i < lengths.Length; i++) if (lengths[i] > 0) { counts[lengths[i]]++; used++; single = i; }
            if (used == 0) throw new IOException("decode");
            if (used == 1) { if (lengths[single] != 1) throw new IOException("decode"); return; }
            single = -1;
            int code = 0;
            for (int i = 1; i <= 15; i++) { code = (code + counts[i - 1]) << 1; next[i] = code; }
            if (code + counts[15] != 32768) throw new IOException("decode");
            zero = new int[used * 2]; one = new int[used * 2];
            int nodes = 1;
            for (int symbol = 0; symbol < lengths.Length; symbol++)
            {
                int length = lengths[symbol]; if (length == 0) continue;
                int value = next[length]++, node = 0;
                for (int i = length - 1; i >= 0; i--)
                {
                    int[] branch = ((value >> i) & 1) == 0 ? zero : one;
                    if (i == 0) { if (branch[node] != 0) throw new IOException("decode"); branch[node] = -symbol - 1; }
                    else
                    {
                        if (branch[node] < 0) throw new IOException("decode");
                        if (branch[node] == 0) { if (nodes >= zero.Length) throw new IOException("decode"); branch[node] = nodes++; }
                        node = branch[node];
                    }
                }
            }
        }
        public int Symbol(WebPLossless b)
        {
            if (single >= 0) { b.Check(); return single; }
            int node = 0;
            for (int i = 0; i < 15; i++)
            {
                node = b.Read(1) == 0 ? zero[node] : one[node];
                if (node < 0) return -node - 1;
                if (node == 0) break;
            }
            throw new IOException("decode");
        }
    }
    static readonly int[] Order = {17,18,0,1,2,3,4,5,16,6,7,8,9,10,11,12,13,14,15};
    Code Huffman(int alphabet)
    {
        Reserve(alphabet * 5);
        var lengths = new int[alphabet];
        if (Read(1) != 0)
        {
            int count = Read(1) + 1, first = Read(1), symbol = Read(first == 0 ? 1 : 8);
            if (symbol >= alphabet) throw new IOException("decode");
            lengths[symbol] = 1;
            if (count == 2) { symbol = Read(8); if (symbol >= alphabet) throw new IOException("decode"); lengths[symbol] = 1; }
        }
        else
        {
            int n = Read(4) + 4;
            var cl = new int[19];
            for (int i = 0; i < n; i++) cl[Order[i]] = Read(3);
            var codes = new Code(cl);
            int max = alphabet;
            if (Read(1) != 0) { int bits = 2 + 2 * Read(3); max = 2 + Read(bits); if (max > alphabet) throw new IOException("decode"); }
            int at = 0, previous = 8;
            while (at < alphabet && max-- > 0)
            {
                int v = codes.Symbol(this);
                if (v <= 15) { lengths[at++] = v; if (v != 0) previous = v; }
                else
                {
                    int count = v == 16 ? Read(2) + 3 : v == 17 ? Read(3) + 3 : Read(7) + 11;
                    if (count > alphabet - at) throw new IOException("decode");
                    for (int j = 0; j < count; j++) lengths[at++] = v == 16 ? previous : 0;
                }
            }
        }
        return new Code(lengths);
    }
    int Prefix(int v)
    {
        if (v < 4) return v + 1;
        int bits = (v - 2) >> 1;
        return ((2 + (v & 1)) << bits) + Read(bits) + 1;
    }
    // Normative distance map, expressed as x,y pairs in increasing code order.
    static readonly int[] Distances = {
        0,1, 1,0, 1,1, -1,1, 0,2, 2,0, 1,2, -1,2, 2,1, -2,1, 2,2, -2,2, 0,3, 3,0,
        1,3, -1,3, 3,1, -3,1, 2,3, -2,3, 3,2, -3,2, 0,4, 4,0, 1,4, -1,4, 4,1, -4,1,
        3,3, -3,3, 2,4, -2,4, 4,2, -4,2, 0,5, 3,4, -3,4, 4,3, -4,3, 5,0, 1,5, -1,5,
        5,1, -5,1, 2,5, -2,5, 5,2, -5,2, 4,4, -4,4, 3,5, -3,5, 5,3, -5,3, 0,6, 6,0,
        1,6, -1,6, 6,1, -6,1, 2,6, -2,6, 6,2, -6,2, 4,5, -4,5, 5,4, -5,4, 3,6, -3,6,
        6,3, -6,3, 0,7, 7,0, 1,7, -1,7, 5,5, -5,5, 7,1, -7,1, 4,6, -4,6, 6,4, -6,4,
        2,7, -2,7, 7,2, -7,2, 3,7, -3,7, 7,3, -7,3, 5,6, -5,6, 6,5, -6,5, 8,0, 4,7,
        -4,7, 7,4, -7,4, 8,1, 8,2, 6,6, -6,6, 8,3, 5,7, -5,7, 7,5, -7,5, 8,4, 6,7,
        -6,7, 7,6, -7,6, 8,5, 7,7, -7,7, 8,6, 8,7 };
    static int Sub(int n, int bits) { return (n + (1 << bits) - 1) >> bits; }
    uint[] Image(int width, int height, bool main)
    {
        bool hasCache = Read(1) != 0;
        int cacheBits = hasCache ? Read(4) : 0;
        if (cacheBits > 11 || hasCache && cacheBits == 0) throw new IOException("decode");
        int cacheSize = cacheBits == 0 ? 0 : 1 << cacheBits;
        var cache = new uint[cacheSize];
        uint[] meta = null;
        int groups = 1, metaBits = 0, metaWidth = 0;
        if (main && Read(1) != 0)
        {
            metaBits = Read(3) + 2; metaWidth = Sub(width, metaBits);
            meta = Image(metaWidth, Sub(height, metaBits), false);
            foreach (uint p in meta) groups = Math.Max(groups, (int)((p >> 8) & 65535) + 1);
            if (groups > 256) throw new IOException("size");
        }
        var codes = new Code[groups][];
        for (int i = 0; i < groups; i++) codes[i] = new[] { Huffman(280 + cacheSize), Huffman(256), Huffman(256), Huffman(256), Huffman(40) };
        Reserve(width * height);
        var pixels = new uint[width * height];
        for (int at = 0; at < pixels.Length;)
        {
            Check();
            int group = meta == null ? 0 : (int)((meta[((at / width) >> metaBits) * metaWidth + ((at % width) >> metaBits)] >> 8) & 65535);
            var code = codes[group];
            int v = code[0].Symbol(this), count = 1, start = at;
            if (v < 256)
            {
                int r = code[1].Symbol(this), b = code[2].Symbol(this), a = code[3].Symbol(this);
                pixels[at++] = (uint)((a << 24) | (r << 16) | (v << 8) | b);
            }
            else if (v < 280)
            {
                count = Prefix(v - 256);
                int distance = Prefix(code[4].Symbol(this));
                if (distance <= 120) distance = Math.Max(1, Distances[(distance - 1) * 2] + Distances[(distance - 1) * 2 + 1] * width);
                else distance -= 120;
                if (distance > at || count > pixels.Length - at) throw new IOException("decode");
                for (int i = 0; i < count; i++, at++) { Check(); pixels[at] = pixels[at - distance]; }
            }
            else
            {
                if (v - 280 >= cacheSize) throw new IOException("decode");
                pixels[at++] = cache[v - 280];
            }
            if (cacheSize > 0) for (int i = start; i < at; i++) cache[unchecked(0x1e35a7bdU * pixels[i]) >> (32 - cacheBits)] = pixels[i];
        }
        return pixels;
    }
    sealed class Transform
    {
        public int Type, Width, Bits, MetaWidth;
        public uint[] Values;
    }
    static int C(uint v, int shift) { return (int)((v >> shift) & 255); }
    static uint Add(uint a, uint b)
    {
        uint v = 0; for (int s = 0; s <= 24; s += 8) v |= (uint)((C(a,s) + C(b,s)) & 255) << s; return v;
    }
    static uint Average(uint a, uint b)
    {
        uint v = 0; for (int s = 0; s <= 24; s += 8) v |= (uint)((C(a,s) + C(b,s)) / 2) << s; return v;
    }
    static uint Predict(int mode, uint l, uint t, uint tl, uint tr)
    {
        switch (mode)
        {
            case 0: return 0xff000000; case 1: return l; case 2: return t; case 3: return tr; case 4: return tl;
            case 5: return Average(Average(l,tr),t); case 6: return Average(l,tl); case 7: return Average(l,t);
            case 8: return Average(tl,t); case 9: return Average(t,tr); case 10: return Average(Average(l,tl),Average(t,tr));
            case 11:
                int dl = 0, dt = 0;
                for (int s = 0; s <= 24; s += 8) { dl += Math.Abs(C(t,s) - C(tl,s)); dt += Math.Abs(C(l,s) - C(tl,s)); }
                return dl < dt ? l : t;
            case 12: case 13:
                uint v = 0;
                for (int s = 0; s <= 24; s += 8)
                {
                    int a = C(l,s), b = C(t,s), c = C(tl,s), avg = (a+b)/2;
                    int value = mode == 12 ? a+b-c : avg+(avg-c)/2;
                    v |= (uint)Math.Max(0,Math.Min(255,value)) << s;
                }
                return v;
            default: throw new IOException("decode");
        }
    }
    uint[] Pixels(int width, int height)
    {
        var transforms = new List<Transform>();
        int seen = 0, currentWidth = width;
        while (Read(1) != 0)
        {
            int type = Read(2);
            if ((seen & (1 << type)) != 0) throw new IOException("decode");
            seen |= 1 << type;
            var tr = new Transform { Type = type, Width = currentWidth };
            if (type < 2)
            {
                tr.Bits = Read(3) + 2; tr.MetaWidth = Sub(currentWidth, tr.Bits);
                tr.Values = Image(tr.MetaWidth, Sub(height, tr.Bits), false);
                if (type == 0) foreach (uint p in tr.Values) if (C(p,8) > 13) throw new IOException("decode");
            }
            else if (type == 3)
            {
                int count = Read(8) + 1;
                tr.Values = Image(count, 1, false);
                for (int i = 1; i < count; i++) tr.Values[i] = Add(tr.Values[i], tr.Values[i-1]);
                tr.Bits = count <= 2 ? 3 : count <= 4 ? 2 : count <= 16 ? 1 : 0;
                currentWidth = Sub(currentWidth, tr.Bits);
            }
            transforms.Add(tr);
        }
        uint[] pixels = Image(currentWidth, height, true);
        transforms.Reverse();
        foreach (var tr in transforms)
        {
            if (tr.Type == 3)
            {
                Reserve(tr.Width * height);
                var expanded = new uint[tr.Width * height];
                int bits = 8 >> tr.Bits, mask = (1 << bits) - 1;
                for (int y = 0; y < height; y++) for (int x = 0; x < tr.Width; x++)
                {
                    Check();
                    int index = (C(pixels[y * currentWidth + (x >> tr.Bits)],8) >> ((x & ((1 << tr.Bits)-1)) * bits)) & mask;
                    expanded[y*tr.Width+x] = index < tr.Values.Length ? tr.Values[index] : 0;
                }
                pixels = expanded; currentWidth = tr.Width; continue;
            }
            for (int i = 0; i < pixels.Length; i++)
            {
                Check();
                uint p = pixels[i]; int x = i % currentWidth, y = i / currentWidth;
                if (tr.Type == 0)
                {
                    uint prediction = i == 0 ? 0xff000000 : y == 0 ? pixels[i-1] : x == 0 ? pixels[i-currentWidth] :
                        Predict(C(tr.Values[(y >> tr.Bits)*tr.MetaWidth+(x >> tr.Bits)],8), pixels[i-1], pixels[i-currentWidth],
                            pixels[i-currentWidth-1], x+1 == currentWidth ? pixels[y*currentWidth] : pixels[i-currentWidth+1]);
                    pixels[i] = Add(p,prediction);
                }
                else
                {
                    int g = C(p,8), r = C(p,16), b = C(p,0);
                    if (tr.Type == 2) { r += g; b += g; }
                    else
                    {
                        uint c = tr.Values[(y >> tr.Bits)*tr.MetaWidth+(x >> tr.Bits)];
                        r = (r + ((unchecked((sbyte)C(c,0)) * unchecked((sbyte)g)) >> 5)) & 255;
                        b += (unchecked((sbyte)C(c,8)) * unchecked((sbyte)g)) >> 5;
                        b += (unchecked((sbyte)C(c,16)) * unchecked((sbyte)r)) >> 5;
                    }
                    pixels[i] = (p & 0xff00ff00) | ((uint)(r & 255) << 16) | (uint)(b & 255);
                }
            }
        }
        return pixels;
    }
    static uint Le(byte[] b, int at) { return (uint)(b[at] | b[at+1] << 8 | b[at+2] << 16 | b[at+3] << 24); }
    public static byte[] Decode(byte[] bytes, out int width, out int height, Func<bool> cancelled = null)
    {
        width = height = 0;
        if (bytes.Length < 25 || bytes.Length > 8 * 1024 * 1024 || Encoding.ASCII.GetString(bytes,0,4) != "RIFF" ||
            Le(bytes,4) != bytes.Length - 8 || Encoding.ASCII.GetString(bytes,8,4) != "WEBP") throw new IOException("type");
        int at = 12, payload = -1, length = 0, canvasW = 0, canvasH = 0;
        while (at < bytes.Length)
        {
            if (bytes.Length-at < 8) throw new IOException("decode");
            uint n = Le(bytes,at+4); if (n > bytes.Length-at-8) throw new IOException("decode");
            string tag = Encoding.ASCII.GetString(bytes,at,4);
            if (tag == "VP8L") { if (payload >= 0) throw new IOException("decode"); payload = at+8; length = (int)n; }
            else if (tag == "VP8X")
            {
                if (at != 12 || n != 10 || (bytes[at+8] & ~0x10) != 0 || bytes[at+9] != 0 || bytes[at+10] != 0 || bytes[at+11] != 0) throw new IOException("type");
            }
            else throw new IOException("type");
            if (tag == "VP8X") {
                canvasW = 1 + bytes[at+12] + (bytes[at+13] << 8) + (bytes[at+14] << 16);
                canvasH = 1 + bytes[at+15] + (bytes[at+16] << 8) + (bytes[at+17] << 16);
            }
            at += 8 + (int)n + ((int)n & 1);
            if (at > bytes.Length) throw new IOException("decode");
        }
        if (payload < 0 || length < 5) throw new IOException("type");
        var decoder = new WebPLossless(bytes,payload,length,cancelled);
        if (decoder.Read(8) != 0x2f) throw new IOException("type");
        width = decoder.Read(14)+1; height = decoder.Read(14)+1;
        decoder.Read(1); if (decoder.Read(3) != 0) throw new IOException("type");
        if (canvasW != 0 && (width != canvasW || height != canvasH)) throw new IOException("size");
        if (width > 1536 || height > 2288) throw new IOException("size");
        uint[] pixels = decoder.Pixels(width,height);
        // Only the final byte's unused high bits may remain.
        if (decoder.end - decoder.bit > 7) throw new IOException("decode");
        var result = new byte[width*height*4];
        for (int i = 0; i < pixels.Length; i++)
        {
            decoder.Check(); int a = C(pixels[i],24);
            result[i*4] = (byte)(C(pixels[i],0)*a/255); result[i*4+1] = (byte)(C(pixels[i],8)*a/255);
            result[i*4+2] = (byte)(C(pixels[i],16)*a/255); result[i*4+3] = (byte)a;
        }
        return result;
    }
}
}
