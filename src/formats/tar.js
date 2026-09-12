'use strict';

/**
 * Minimal USTAR/PAX-capable tar writer (dependency free).
 * Produces a stream of 512-byte blocks; long names use PAX extended headers
 * so GNU tar / bsdtar read them correctly.
 */

const BLOCK = 512;

function writeString(buf, offset, str, len) {
  const b = Buffer.from(str, 'utf8');
  b.copy(buf, offset, 0, Math.min(b.length, len));
}

function writeOctal(buf, offset, value, len) {
  // len includes the trailing NUL
  const s = Math.max(0, Math.floor(value))
    .toString(8)
    .padStart(len - 1, '0')
    .slice(-(len - 1));
  writeString(buf, offset, `${s}\0`, len);
}

/**
 * Split a path into ustar's prefix(<=155) + name(<=100).
 * Returns null when the path cannot be represented that way (needs PAX).
 */
function ustarSplit(fullName) {
  if (Buffer.byteLength(fullName, 'utf8') <= 100) return { prefix: '', name: fullName };
  for (let i = fullName.length - 1; i > 0; i--) {
    if (fullName[i] !== '/') continue;
    const suffix = fullName.slice(i + 1);
    const prefix = fullName.slice(0, i);
    if (
      Buffer.byteLength(suffix, 'utf8') <= 100 &&
      Buffer.byteLength(prefix, 'utf8') <= 155 &&
      prefix.length > 0
    ) {
      return { prefix, name: suffix };
    }
  }
  return null;
}

/** A ustar header block for one entry. */
function header({ name, size, mtimeMs, mode = 0o644, type = '0' }) {
  const buf = Buffer.alloc(BLOCK, 0);
  const mtime = Math.floor((mtimeMs || Date.now()) / 1000);

  const split = ustarSplit(name) || { prefix: '', name: name.slice(-100) };
  const filename = split.name;
  const prefix = split.prefix;

  writeString(buf, 0, filename.slice(0, 100), 100);
  writeOctal(buf, 100, mode & 0o7777, 8);
  writeOctal(buf, 108, 0, 8); // uid
  writeOctal(buf, 116, 0, 8); // gid
  writeOctal(buf, 124, size, 12);
  writeOctal(buf, 136, mtime, 12);
  writeString(buf, 148, '        ', 8); // checksum placeholder (spaces)
  writeString(buf, 156, type, 1);
  writeString(buf, 257, 'ustar\0', 6);
  writeString(buf, 263, '00', 2);
  writeString(buf, 345, prefix.slice(0, 155), 155);

  // checksum = sum of all bytes with the checksum field as spaces
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  const chk = sum.toString(8).padStart(6, '0') + '\0 ';
  writeString(buf, 148, chk, 8);

  return buf;
}

/** PAX extended header for very long names (>255 bytes) or other overrides. */
function paxHeader(name, size, mtimeMs, records) {
  let payload = '';
  for (const [k, v] of Object.entries(records)) {
    const entry = `${k}=${v}\n`;
    // length must include the length digits themselves
    let len = Buffer.byteLength(entry, 'utf8') + 2;
    let line = `${len} ${entry}`;
    while (Buffer.byteLength(line, 'utf8') !== len) {
      len = Buffer.byteLength(line, 'utf8');
      line = `${len} ${entry}`;
    }
    payload += line;
  }
  const data = Buffer.from(payload, 'utf8');
  const paxName = paxPathName(name);
  const hdr = header({ name: paxName, size: data.length, mtimeMs, mode: 0o644, type: 'x' });
  const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
  return Buffer.concat([hdr, data, Buffer.alloc(pad, 0)]);
}

function paxPathName(name) {
  // The PAX header itself needs a short name.
  const base = name.split('/').pop() || 'entry';
  const dir = name.slice(0, name.length - base.length);
  const short = `PaxHeader/${base}`.slice(-100);
  return dir.length < 100 ? `${dir}${short}`.slice(0, 100) : short;
}

/**
 * Async generator yielding tar blocks for a list of files.
 * @param {Array<{rel:string, abs:string, size:number, mtimeMs:number}>} entries
 */
async function* tarStream(entries) {
  const fsp = require('fs').promises;
  for (const e of entries) {
    const name = e.rel;
    const needsPax = !ustarSplit(name) || e.size > 0o77777777777;
    if (needsPax) {
      yield paxHeader(name, e.size, e.mtimeMs, { path: name });
    }
    yield header({ name, size: e.size, mtimeMs: e.mtimeMs, type: '0' });
    // file data in 512-byte blocks
    const fh = await fsp.open(e.abs, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      let remaining = e.size;
      while (remaining > 0) {
        const toRead = Math.min(buf.length, remaining);
        const { bytesRead } = await fh.read(buf, 0, toRead, null);
        if (bytesRead <= 0) break;
        yield Buffer.from(buf.subarray(0, bytesRead));
        remaining -= bytesRead;
      }
    } finally {
      await fh.close();
    }
    const pad = (BLOCK - (e.size % BLOCK)) % BLOCK;
    if (pad) yield Buffer.alloc(pad, 0);
  }
  // two zero blocks terminate the archive
  yield Buffer.alloc(BLOCK * 2, 0);
}

module.exports = { tarStream, header, ustarSplit, BLOCK };
