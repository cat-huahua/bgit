'use strict';

/**
 * Extract an archive created by bgit (or any tar/zip).
 * Uses the system `tar` / `unzip` when available, which handles every format
 * robustly (including xz/bz2/zst).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function which(bin) {
  for (const d of (process.env.PATH || '').split(':')) {
    const p = path.join(d, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) {
      /* keep looking */
    }
  }
  return null;
}

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: 'inherit', ...opts });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exited with code ${code}`))));
  });
}

/**
 * @param {string} archivePath
 * @param {string} destDir
 */
async function extractArchive(archivePath, destDir) {
  const abs = path.resolve(archivePath);
  if (!fs.existsSync(abs)) {
    const err = new Error(`Archive not found: ${abs}`);
    err.code = 'ENOENT_ARCHIVE';
    throw err;
  }
  fs.mkdirSync(destDir, { recursive: true });

  const lower = abs.toLowerCase();
  const isZip = lower.endsWith('.zip') || lower.endsWith('.jar');

  if (isZip) {
    const unzip = which('unzip');
    if (unzip) return run(unzip, ['-o', abs, '-d', destDir]);
    const bsdtar = which('bsdtar');
    if (bsdtar) return run(bsdtar, ['-xf', abs, '-C', destDir]);
    const err = new Error('Need `unzip` (or `bsdtar`) to extract zip files. Install unzip and retry.');
    err.code = 'MISSING_TOOL';
    throw err;
  }

  const tar = which('tar');
  if (!tar) {
    const err = new Error('Need `tar` to extract tar archives. Install tar and retry.');
    err.code = 'MISSING_TOOL';
    throw err;
  }
  // GNU tar auto-detects gz/bz2/xz/zst by content; -C sets the output dir.
  return run(tar, ['-xf', abs, '-C', destDir]);
}

module.exports = { extractArchive };
