'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

/** Human readable size. */
function human(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(bytes) || 0;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(p);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * Retry an async operation a few times. Network mounts (SMB/NFS) and FUSE
 * mounts (Nutstore, rclone) occasionally fail transiently; retrying makes
 * bgit reliable on flaky storage.
 */
async function withRetry(fn, { tries = 3, delayMs = 300, label = '' } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < tries) await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
  if (label) lastErr.message = `${label}: ${lastErr.message}`;
  throw lastErr;
}

function isExcluded(rel, excludes) {
  if (!rel) return false;
  for (const ex of excludes) {
    const clean = ex.replace(/\/+$/, '');
    if (!clean) continue;
    if (rel === clean || rel.startsWith(`${clean}/`)) return true;
    // also match by base name anywhere
    if (rel.split('/').includes(clean)) return true;
  }
  return false;
}

/**
 * Recursively list files under root.
 * @returns {Promise<Map<string,{size:number,mtimeMs:number}>>} relative path -> stat
 */
async function walk(root, excludes = []) {
  const out = new Map();
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    if (isExcluded(rel, excludes)) continue;
    const dir = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = await withRetry(() => fsp.readdir(dir, { withFileTypes: true }), { tries: 2 });
    } catch (_) {
      continue;
    }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (isExcluded(childRel, excludes)) continue;
      if (ent.isSymbolicLink()) continue; // never follow symlinks
      if (ent.isDirectory()) {
        stack.push(childRel);
      } else if (ent.isFile()) {
        try {
          const st = await fsp.stat(path.join(root, childRel));
          out.set(childRel, { size: st.size, mtimeMs: st.mtimeMs });
        } catch (_) {
          /* unreadable -> skip */
        }
      }
    }
  }
  return out;
}

/**
 * Are these two files the same content?
 *
 * Correctness rule: a differing size means different content, but an EQUAL
 * size is never enough to conclude "same" -- two files written moments apart
 * often share a timestamp, and a changed file that happens to keep the same
 * length would otherwise be silently skipped (losing the new version).
 * So whenever the sizes match we always compare hashes.
 */
async function sameContent(pathA, statsA, statsB, pathB) {
  if (statsA.size !== statsB.size) return false;
  try {
    const [h1, h2] = await Promise.all([hashFile(pathA), hashFile(pathB)]);
    return h1 === h2;
  } catch (_) {
    return false; // unreadable -> treat as different so nothing is lost
  }
}

function splitVersion(name) {
  const m = /^(.*)\.v(\d+)$/.exec(name);
  if (m) return { base: m[1], v: parseInt(m[2], 10) };
  return { base: name, v: 0 };
}

/** Highest existing .vN number for `base` in dir (0 when none). */
function highestVersion(dir, base) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return 0;
  }
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}\\.v(\\d+)$`);
  let max = 0;
  for (const n of names) {
    const m = re.exec(n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

/** Timestamp for filenames: 20260912-154825 */
function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fmtTime(ms) {
  if (!ms) return '-';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  human,
  sha1,
  hashFile,
  withRetry,
  isExcluded,
  walk,
  sameContent,
  splitVersion,
  highestVersion,
  stamp,
  fmtTime,
  ensureDir,
  exists,
};
