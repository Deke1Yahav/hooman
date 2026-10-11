// PNG label images: our own decoder, because a canvas turns 16-bit and palette labels into colours.
// Also: header-only size sniffing for JPEG/PNG/WebP/GIF, and a label-PNG encoder for exported masks.

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

async function inflateZlib(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function deflateZlib(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export class PngError extends Error {}

// -> {width, height, labels: Uint32Array}; 0 = background, any other value = one object.
export async function decodeLabelPNG(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) throw new PngError("not a PNG file");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (p + 8 <= b.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = b[p + 16]; ctype = b[p + 17]; interlace = b[p + 20];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (!w || !h) throw new PngError("PNG has no size header");
  if (interlace) throw new PngError("interlaced PNG; save the mask without interlacing");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!channels) throw new PngError(`unknown PNG colour type ${ctype}`);
  const total = idat.reduce((s, x) => s + x.length, 0);
  const z = new Uint8Array(total);
  let o = 0;
  for (const x of idat) { z.set(x, o); o += x.length; }
  const raw = await inflateZlib(z);
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((w * channels * depth) / 8);
  if (raw.length < h * (stride + 1)) throw new PngError("PNG data is cut short");
  const img = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {                 // undo the per-row filters
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? img[row + x - bpp] : 0, c0 = y ? img[up + x] : 0, c = x >= bpp && y ? img[up + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += c0;
      else if (f === 3) v += (a + c0) >> 1;
      else if (f === 4) {
        const pp = a + c0 - c, pa = Math.abs(pp - a), pb = Math.abs(pp - c0), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? c0 : c;
      }
      img[row + x] = v;
    }
  }
  const labels = new Uint32Array(w * h);
  const sample = (row, i) => {                  // i-th sample of a row, any bit depth
    if (depth === 8) return img[row + i];
    if (depth === 16) return (img[row + 2 * i] << 8) | img[row + 2 * i + 1];
    const per = 8 / depth, byte = img[row + Math.floor(i / per)], shift = 8 - depth * (1 + (i % per));
    return (byte >> shift) & ((1 << depth) - 1);
  };
  for (let y = 0; y < h; y++) {
    const row = y * stride, out = y * w;
    for (let x = 0; x < w; x++) {
      let v;
      if (channels === 1) v = sample(row, x);
      else if (channels === 2) v = sample(row, 2 * x + 1) === 0 ? 0 : sample(row, 2 * x);
      else {
        const k = channels * x, top = depth === 16 ? 8 : 0;
        if (channels === 4 && sample(row, k + 3) === 0) v = 0;
        else v = ((sample(row, k) >> top) << 16) | ((sample(row, k + 1) >> top) << 8) | (sample(row, k + 2) >> top);
      }
      labels[out + x] = v;
    }
  }
  return { width: w, height: h, labels };
}

// labels (Uint32Array/Uint16Array, w*h) -> PNG bytes; 8-bit grey when all labels < 256, else 16-bit grey.
export async function encodeLabelPNG(labels, w, h) {
  let max = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] > max) max = labels[i];
  if (max > 65535) throw new PngError("more than 65535 objects in one mask");
  const depth = max < 256 ? 8 : 16, bpp = depth >> 3, stride = w * bpp;
  const raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    let q = y * (stride + 1) + 1;              // filter byte 0 (none) is already 0
    for (let x = 0; x < w; x++) {
      const v = labels[y * w + x];
      if (depth === 8) raw[q++] = v; else { raw[q++] = v >> 8; raw[q++] = v & 255; }
    }
  }
  const ihdr = new Uint8Array(13), idv = new DataView(ihdr.buffer);
  idv.setUint32(0, w); idv.setUint32(4, h); ihdr[8] = depth; ihdr[9] = 0;
  const chunks = [chunk("IHDR", ihdr), chunk("IDAT", await deflateZlib(raw)), chunk("IEND", new Uint8Array(0))];
  return new Blob([new Uint8Array(SIG), ...chunks], { type: "image/png" });
}

let CRC;
function crc(bytes) {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[i] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (const x of bytes) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
}

// Width/height from the first bytes of a JPEG/PNG/WebP/GIF, without decoding. null when unknown.
export function imageSize(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const str = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length >= 24 && b[0] === 137 && str(1, 3) === "PNG") return { type: "png", w: dv.getUint32(16), h: dv.getUint32(20) };
  if (b.length >= 10 && str(0, 4) === "GIF8") return { type: "gif", w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
  if (b.length >= 30 && str(0, 4) === "RIFF" && str(8, 4) === "WEBP") {
    const kind = str(12, 4);
    if (kind === "VP8 ") return { type: "webp", w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
    if (kind === "VP8L") { const v = dv.getUint32(21, true); return { type: "webp", w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    if (kind === "VP8X") return { type: "webp", w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) { p++; continue; }
      const m = b[p + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { p += m === 0xff ? 1 : 2; continue; }
      const len = dv.getUint16(p + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: "jpeg", w: dv.getUint16(p + 7), h: dv.getUint16(p + 5) };
      p += 2 + len;
    }
    return { type: "jpeg", w: 0, h: 0 };
  }
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d))) return { type: "tiff", w: 0, h: 0 };
  return null;
}
