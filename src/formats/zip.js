'use strict';

/**
 * Minimal ZIP writer (dependency free).
 * Uses raw deflate; falls back to "stored" when deflate makes a file bigger.
 * Handles files > 4 GB is not supported (no ZIP64) -- archive mode warns.
 */

const zlib = require('zlib');
const fs = require('fs');
const fsp = fs.promises;

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, seed = 0) {
  let c = seed ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Info-ZIP "Unicode Path" extra field (0x7075).
 * Some unzip builds ignore the UTF-8 flag (bit 11) and re-encode the name as
 * CP437, turning "名前" into mojibake. This extra field tells them the real
 * UTF-8 name so extraction is correct everywhere.
 */
function unicodePathExtra(nameBytes) {
  const extra = Buffer.alloc(4 + 5 + nameBytes.length);
  extra.writeUInt16LE(0x7075, 0);
  extra.writeUInt16LE(5 + nameBytes.length, 2);
  extra.writeUInt8(1, 4); // version
  extra.writeUInt32LE(crc32(nameBytes), 5);
  nameBytes.copy(extra, 9);
  return extra;
}

function dosDateTime(ms) {
  const d = new Date(ms || Date.now());
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * Write a zip archive.
 * @param {string} outPath
 * @param {Array<{rel:string, abs:string, size:number, mtimeMs:number}>} entries
 * @param {{onProgress?:Function, store?:boolean}} opts
 */
async function writeZip(outPath, entries, opts = {}) {
  const out = fs.createWriteStream(outPath);
  const central = [];
  let offset = 0;

  const write = (buf) =>
    new Promise((resolve, reject) => {
      out.write(buf, (err) => (err ? reject(err) : resolve()));
      offset += buf.length;
    });

  for (const e of entries) {
    const nameBuf = Buffer.from(e.rel, 'utf8');
    const { time, date } = dosDateTime(e.mtimeMs);

    const crcState = { c: 0 };
    let compressed;
    let method = 8;
    const raw = await fsp.readFile(e.abs);

    if (opts.store) {
      compressed = raw;
      method = 0;
    } else {
      const deflated = zlib.deflateRawSync(raw, { level: 6 });
      if (deflated.length < raw.length) {
        compressed = deflated;
      } else {
        compressed = raw;
        method = 0;
      }
    }
    const crc = crc32(raw);
    const extra = unicodePathExtra(nameBuf);

    // ---- local file header ----
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(date, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(extra.length, 28);
    const localOffset = offset;
    await write(Buffer.concat([lfh, nameBuf, extra]));
    await write(compressed);

    central.push({ nameBuf, extra, method, time, date, crc, csize: compressed.length, usize: raw.length, offset: localOffset });

    if (opts.onProgress) opts.onProgress({ phase: 'archive', message: e.rel });
  }

  // ---- central directory ----
  const cdStart = offset;
  for (const c of central) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8); // UTF-8
    cd.writeUInt16LE(c.method, 10);
    cd.writeUInt16LE(c.time, 12);
    cd.writeUInt16LE(c.date, 14);
    cd.writeUInt32LE(c.crc, 16);
    cd.writeUInt32LE(c.csize, 20);
    cd.writeUInt32LE(c.usize, 24);
    cd.writeUInt16LE(c.nameBuf.length, 28);
    cd.writeUInt16LE(c.extra.length, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0o644 << 16, 38); // external attrs
    cd.writeUInt32LE(c.offset, 42);
    await write(Buffer.concat([cd, c.nameBuf, c.extra]));
  }
  const cdSize = offset - cdStart;

  // ---- end of central directory ----
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  await write(eocd);

  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  return { entries: central.length };
}

module.exports = { writeZip, crc32 };
