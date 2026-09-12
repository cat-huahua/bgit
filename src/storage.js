'use strict';

/**
 * Figures out what kind of storage a path lives on, so bgit can adapt
 * (and report it). bgit itself works on ANY mounted path -- this is only for
 * labelling and for choosing safe defaults.
 *
 * Kinds: sd | nas | cloud | disk | unknown
 */

const fs = require('fs');
const path = require('path');

function readMounts() {
  // Linux: /proc/mounts ; macOS: skip (report unknown) ; fallback: none
  const out = [];
  try {
    const txt = fs.readFileSync('/proc/mounts', 'utf8');
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      const device = parts[0];
      const mp = parts[1].replace(/\\040/g, ' ');
      const fstype = parts[2];
      out.push({ device, mountpoint: mp, fstype });
    }
  } catch (_) {
    /* not linux */
  }
  return out;
}

function classifyFstype(fstype, device) {
  const f = String(fstype || '').toLowerCase();
  const d = String(device || '').toLowerCase();

  if (/(^|\/)(cifs|smb3?|nfs4?|nfsd|afp|fuse\.smbnetfs)$/.test(f)) return 'nas';
  if (/(^|\.)(cifs|nfs)/.test(f)) return 'nas';
  if (f === 'vfat' || f === 'exfat' || f === 'msdos' || f === 'fuseblk') return 'sd';
  if (f === 'ntfs' || f === 'ntfs3') return 'disk';
  if (f.startsWith('fuse.')) {
    if (/nutstore|nut|davfs|webdav|rclone|gdrive|onedrive|dropbox|cloud/i.test(f)) return 'cloud';
    if (/smb/i.test(f)) return 'nas';
    return 'cloud';
  }
  if (/^(ext[234]|xfs|btrfs|zfs|f2fs|jfs|reiserfs)$/.test(f)) {
    // An SD card is often mmcblk even with ext4.
    if (/mmcblk/.test(d)) return 'sd';
    return 'disk';
  }
  if (/mmcblk|^\/dev\/sd[a-z]/.test(d)) return 'sd';
  if (/^\/dev\/(disk|nvme)/.test(d)) return 'disk';
  return 'unknown';
}

/**
 * @returns {{kind:string, fstype:string|null, device:string|null, mountpoint:string|null}}
 */
function detectStorage(targetPath) {
  const abs = path.resolve(targetPath);
  const mounts = readMounts();
  let best = null;
  for (const m of mounts) {
    if (abs === m.mountpoint || abs.startsWith(m.mountpoint === '/' ? '/' : `${m.mountpoint}/`)) {
      if (!best || m.mountpoint.length > best.mountpoint.length) best = m;
    }
  }
  if (!best) return { kind: 'unknown', fstype: null, device: null, mountpoint: null };
  return {
    kind: classifyFstype(best.fstype, best.device),
    fstype: best.fstype,
    device: best.device,
    mountpoint: best.mountpoint,
  };
}

const LABEL = {
  sd: 'SD card / memory card',
  nas: 'NAS / network share',
  cloud: 'cloud mount (e.g. Nutstore)',
  disk: 'disk / SSD',
  unknown: 'unknown storage',
};

function describeStorage(targetPath) {
  const s = detectStorage(targetPath);
  return { ...s, label: LABEL[s.kind] || LABEL.unknown };
}

/** Safe defaults per storage kind (kept modest for slow/network mounts). */
function defaultsFor(kind) {
  switch (kind) {
    case 'nas':
      return { retries: 5, concurrency: 2 };
    case 'cloud':
      return { retries: 5, concurrency: 2 };
    case 'sd':
      return { retries: 3, concurrency: 2 };
    default:
      return { retries: 3, concurrency: 4 };
  }
}

module.exports = { detectStorage, describeStorage, defaultsFor, classifyFstype };
