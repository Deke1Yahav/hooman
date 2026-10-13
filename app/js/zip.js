// Minimal zip reader (stored + deflate, zip64) and writer (stored), no dependencies.
// Reading uses the browser's DecompressionStream, so big zips are never loaded whole.

const MIME = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  avif: "image/avif", json: "application/json", csv: "text/csv", txt: "text/plain",
};
export const mimeOf = (path) => MIME[(path.split(".").pop() || "").toLowerCase()] || "application/octet-stream";

const u16 = (dv, o) => dv.getUint16(o, true);
const u32 = (dv, o) => dv.getUint32(o, true);
const u64 = (dv, o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 2 ** 32;

async function bytesAt(blob, start, len) {
  return new DataView(await blob.slice(start, start + len).arrayBuffer());
}

export class ZipError extends Error {}

// Returns Map(path -> {path, size, blob(): Promise<Blob>}); folders and macOS junk are skipped.
export async function readZip(blob) {
  const tailLen = Math.min(blob.size, 65557);
  const tail = await bytesAt(blob, blob.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ZipError("this file is not a zip (no zip directory found)");
  let count = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOff = u32(tail, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const locAt = blob.size - tailLen + eocd - 20;
    const loc = await bytesAt(blob, locAt, 20);
    if (u32(loc, 0) !== 0x07064b50) throw new ZipError("broken zip64 directory");
    const rec = await bytesAt(blob, u64(loc, 8), 56);
    if (u32(rec, 0) !== 0x06064b50) throw new ZipError("broken zip64 directory");
    count = u64(rec, 32); cdSize = u64(rec, 40); cdOff = u64(rec, 48);
  }
  const cd = await bytesAt(blob, cdOff, cdSize);
  const utf8 = new TextDecoder("utf-8");
  const files = new Map();
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (u32(cd, p) !== 0x02014b50) throw new ZipError("broken zip directory");
    const flags = u16(cd, p + 8), method = u16(cd, p + 10);
    let csize = u32(cd, p + 20), size = u32(cd, p + 24);
    const nlen = u16(cd, p + 28), xlen = u16(cd, p + 30), clen = u16(cd, p + 32);
    let off = u32(cd, p + 42);
    const name = utf8.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen));
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x + 4 <= xend) {                    // zip64 extra: only the fields that overflowed, in order
      const id = u16(cd, x), len = u16(cd, x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(cd, q); q += 8; }
        if (off === 0xffffffff) { off = u64(cd, q); q += 8; }
      }
      x += 4 + len;
    }
    p = xend + clen;
    if (name.endsWith("/") || name.startsWith("__MACOSX/") || name.split("/").pop() === ".DS_Store") continue;
    if (flags & 1) throw new ZipError(`"${name}" is encrypted; use a zip without a password`);
    if (method !== 0 && method !== 8) throw new ZipError(`"${name}" uses compression method ${method}; use plain deflate (the default of Python's zipfile and most tools)`);
    files.set(name, {
      path: name, size,
      async blob() {
        if (this.start === undefined) {           // where the data begins: read once, then remembered
          const lh = await bytesAt(blob, off, 30);
          if (u32(lh, 0) !== 0x04034b50) throw new ZipError(`broken zip entry "${name}"`);
          this.start = off + 30 + u16(lh, 26) + u16(lh, 28);
        }
        const start = this.start;
        const raw = blob.slice(start, start + csize);
        if (method === 0) return new Blob([raw], { type: mimeOf(name) });
        const out = await new Response(raw.stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
        return new Blob([out], { type: mimeOf(name) });
      },
    });
  }
  return files;
}

let CRC_TABLE;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{name, data: string | Uint8Array | Blob}] -> Blob (stored, no compression; exports are small or already-compressed PNGs).
export async function writeZip(entries) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const e of entries) {
    const data = typeof e.data === "string" ? enc.encode(e.data)
      : e.data instanceof Blob ? new Uint8Array(await e.data.arrayBuffer()) : e.data;
    const name = enc.encode(e.name), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, x) => s + x.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
