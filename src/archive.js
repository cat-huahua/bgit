'use strict';

/**
 * Archive mode: bundle a folder into one compressed file.
 *
 * Formats
 *   zip                 .zip                 (pure Node)
 *   tar                 .tar                 (pure Node)
 *   tar.gz / tgz        .tar.gz              (pure Node, zlib)
 *   tar.zst / tzst      .tar.zst             (pure Node, Node 22 zstd)
 *   gz                  .gz (single file or tar stream)  (pure Node)
 *   tar.bz2 / tbz2      .tar.bz2             (uses system `bzip2`)
 *   tar.xz  / txz       .tar.xz              (uses system `xz`)
 *
 * "gunzip" in the wild means a .gz file -- that is the `gz` format here.
 * Extract with `bgit extract` (or system tar/unzip).
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');

const { walk, stamp, withRetry } = require('./util');
const { tarStream } = require('./formats/tar');
const { writeZip } = require('./formats/zip');

const FORMATS = {
  zip: { ext: '.zip', kind: 'zip' },
  tar: { ext: '.tar', kind: 'tar' },
  gz: { ext: '.tar.gz', kind: 'tar+gz' },
  tgz: { ext: '.tar.gz', kind: 'tar+gz' },
  'tar.gz': { ext: '.tar.gz', kind: 'tar+gz' },
  zst: { ext: '.tar.zst', kind: 'tar+zst' },
  tzst: { ext: '.tar.zst', kind: 'tar+zst' },
  'tar.zst': { ext: '.tar.zst', kind: 'tar+zst' },
  bz2: { ext: '.tar.bz2', kind: 'tar+external', bin: 'bzip2', args: ['-c'] },
  tbz2: { ext: '.tar.bz2', kind: 'tar+external', bin: 'bzip2', args: ['-c'] },
  'tar.bz2': { ext: '.tar.bz2', kind: 'tar+external', bin: 'bzip2', args: ['-c'] },
  xz: { ext: '.tar.xz', kind: 'tar+external', bin: 'xz', args: ['-c', '-T0'] },
  txz: { ext: '.tar.xz', kind: 'tar+external', bin: 'xz', args: ['-c', '-T0'] },
  'tar.xz': { ext: '.tar.xz', kind: 'tar+external', bin: 'xz', args: ['-c', '-T0'] },
};

function normalizeFormat(name) {
  const f = String(name || 'zip').toLowerCase().replace(/^\./, '');
  return FORMATS[f] ? f : null;
}

function formatList() {
  return Object.keys(FORMATS).sort();
}

/** Which of the formats can actually run here (external tools present)? */
function availableFormats() {
  const out = [];
  for (const name of Object.keys(FORMATS)) {
    const f = FORMATS[name];
    if (f.kind === 'tar+external') {
      if (which(f.bin)) out.push(name);
    } else {
      out.push(name);
    }
  }
  return out;
}

let whichCache = new Map();
function which(bin) {
  if (whichCache.has(bin)) return whichCache.get(bin);
  const dirs = (process.env.PATH || '').split(':');
  let found = null;
  for (const d of dirs) {
    const p = path.join(d, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      found = p;
      break;
    } catch (_) {
      /* keep looking */
    }
  }
  whichCache.set(bin, found);
  return found;
}

function assertFormatUsable(name) {
  const f = FORMATS[name];
  if (f.kind === 'tar+external' && !which(f.bin)) {
    const err = new Error(
      `Format "${name}" needs the "${f.bin}" command, which is not installed.\n` +
        `Install it (e.g. sudo apt install ${f.bin}) or pick another format: ${availableFormats().join(', ')}`
    );
    err.code = 'MISSING_TOOL';
    throw err;
  }
}

/**
 * Create an archive of `src`.
 * @param {object} o
 * @param {string} o.src
 * @param {string} o.outDir   where the archive is written
 * @param {string} [o.name]   base name (default: folder name)
 * @param {string} [o.format]
 * @param {string[]} [o.excludes]
 * @param {Function} [o.onProgress]
 */
async function createArchive({ src, outDir, name, format = 'zip', excludes = [], onProgress = () => {} }) {
  const fmtName = normalizeFormat(format);
  if (!fmtName) {
    const err = new Error(`Unknown format "${format}". Available: ${formatList().join(', ')}`);
    err.code = 'BAD_FORMAT';
    throw err;
  }
  assertFormatUsable(fmtName);
  const fmt = FORMATS[fmtName];

  const absSrc = path.resolve(src);
  const baseName = name || path.basename(absSrc) || 'backup';
  const outName = `${baseName}-${stamp()}${fmt.ext}`;
  const outPath = path.join(outDir, outName);

  onProgress({ phase: 'archive-start', format: fmtName, out: outPath });

  if (fmt.kind === 'zip') {
    const entries = await collectEntries(absSrc, excludes, onProgress);
    await withRetry(() => writeZip(outPath, entries, { onProgress }), { tries: 2, label: 'zip' });
    const st = await fsp.stat(outPath);
    onProgress({ phase: 'archive-done', out: outPath, size: st.size, count: entries.length });
    return { path: outPath, format: fmtName, size: st.size, count: entries.length };
  }

  // tar-based
  const entries = await collectEntries(absSrc, excludes, onProgress);

  if (fmt.kind === 'tar') {
    await pipeline(tarStream(entries), fs.createWriteStream(outPath));
  } else if (fmt.kind === 'tar+gz') {
    await pipeline(tarStream(entries), zlib.createGzip({ level: 6 }), fs.createWriteStream(outPath));
  } else if (fmt.kind === 'tar+zst') {
    if (typeof zlib.createZstdCompress !== 'function') {
      const err = new Error(
        'This Node build has no zstd support. Use a different --format (tar.gz, zip, xz...) or upgrade Node.'
      );
      err.code = 'NO_ZSTD';
      throw err;
    }
    await pipeline(tarStream(entries), zlib.createZstdCompress(), fs.createWriteStream(outPath));
  } else {
    // tar -> external compressor (bzip2/xz) -> file.
    // The compressor reads tar on stdin and writes compressed bytes on stdout,
    // so BOTH pipes must be connected (or the process deadlocks on a full buffer).
    const proc = spawn(fmt.bin, fmt.args, { stdio: ['pipe', 'pipe', 'inherit'] });
    const done = new Promise((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${fmt.bin} exited ${code}`))));
    });
    await Promise.all([
      pipeline(tarStream(entries), proc.stdin),
      pipeline(proc.stdout, fs.createWriteStream(outPath)),
      done,
    ]);
  }

  const st = await fsp.stat(outPath);
  onProgress({ phase: 'archive-done', out: outPath, size: st.size, count: entries.length });
  return { path: outPath, format: fmtName, size: st.size, count: entries.length };
}

async function collectEntries(src, excludes, onProgress) {
  const map = await walk(src, excludes);
  const entries = [];
  for (const [rel, st] of map) {
    entries.push({ rel, abs: path.join(src, rel), size: st.size, mtimeMs: st.mtimeMs });
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  onProgress({ phase: 'collect', count: entries.length });
  return entries;
}

module.exports = { createArchive, normalizeFormat, formatList, availableFormats, FORMATS };
