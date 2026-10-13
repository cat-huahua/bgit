# bgit — backup git

Versioned backups that work on **any mounted storage** — SD card, NAS share, USB
disk, or a cloud mount like Nutstore — with an optional **archive mode** that
packs a folder into a single compressed file (`.zip`, `.tar`, `.tar.gz`,
`.tar.bz2`, `.tar.xz`, `.tar.zst`, `.gz`).

No dependencies. Pure Node.js.

```
bgit sync    --src DIR --dst DIR [--commit]     versioned merge (default)
bgit archive --src DIR --dst DIR --format FMT [--commit]
bgit extract ARCHIVE --dst DIR
bgit info    --dst DIR
bgit formats
```

---

## Why "backup git"

It behaves like a tiny version-control system for your files:

| Situation | What bgit does | Result |
| --- | --- | --- |
| Same file, **identical content** | nothing | — |
| Same file, **changed content** | keeps **both** | old → `name.v1`, new → `name.v2` (then `.v3`, `.v4`…) |
| File only in the **source** | stored as new | `name.NA` (*newly added*) |
| File only in the **destination** | marked deleted | `name.D` (*deleted from source*) |
| Already marked (`.NA`, `.D`, `.v1`…) | skipped | — |

**bgit never deletes and never overwrites.** A file that vanished from the
source is only *renamed* with `.D` — the contents stay forever.

`.v1` is always the oldest version; the highest number is the newest.
Timestamps live in the files' normal properties (nothing is encoded in names).

Every commit writes a report, `_BGIT-REPORT-<timestamp>.txt`, listing each
action with git-style marks:

```
mark  time                 file  ->  stored as
A     2026-09-12 15:48:30  photos/pic.jpg  ->  photos/pic.jpg.NA
M     2026-09-11 16:00:00  notes.txt
                                old -> notes.txt.v1
                                new -> notes.txt.v2
D     2025-12-01 08:00:00  remove-me.txt  ->  remove-me.txt.D
```

---

## Storage: SD, NAS, disk, Nutstore

bgit doesn't care what the destination is — it works on any mounted path. It
detects the storage type and reports it (and raises retry counts on flaky
storage):

| Detected | Typical fstype |
| --- | --- |
| `SD card / memory card` | `vfat`, `exfat`, `mmcblk` devices |
| `NAS / network share` | `cifs`, `smb3`, `nfs` |
| `cloud mount (e.g. Nutstore)` | `fuse.*` (Nutstore, rclone, WebDAV) |
| `disk / SSD` | `ext4`, `xfs`, `btrfs`, `ntfs`… |

```bash
bgit info --dst /mnt/nas/backups
#   storage   : NAS / network share
#   filesystem: cifs
#   defaults  : retries=5 concurrency=2
```

Network and FUSE mounts occasionally fail mid-write, so bgit wraps every file
operation in a retry. If the destination isn't mounted, bgit **refuses to run**
rather than creating a stray empty folder.

---

## Archive mode

Compress a folder into one file. All formats round-trip through the system
`tar`/`unzip`, so anything can open them.

| `--format` | Extension | Needs |
| --- | --- | --- |
| `zip` | `.zip` | built in |
| `tar` | `.tar` | built in |
| `tar.gz` / `tgz` / `gz` | `.tar.gz` | built in |
| `tar.zst` / `tzst` / `zst` | `.tar.zst` | built in (Node 22+) |
| `tar.bz2` / `tbz2` / `bz2` | `.tar.bz2` | system `bzip2` |
| `tar.xz` / `txz` / `xz` | `.tar.xz` | system `xz` |

`gz` here means a gzipped tar (what people usually call "gunzip" files).
Run `bgit formats` to see which formats are available on this machine.

```bash
# a zip of ~/Photos, written to the NAS
bgit archive --src ~/Photos --dst /mnt/nas/backups --format zip --commit
#   -> /mnt/nas/backups/Photos-20260912-153000.zip

# versioned sync AND a compressed snapshot in one go
bgit sync --src ~/Documents --dst /mnt/nas/backups --archive --format tar.gz --commit

# unpack it again
bgit extract /mnt/nas/backups/Photos-20260912-153000.tar.gz --dst ~/restore
```

Archives are named `<name>-<YYYYMMDD-HHMMSS>.<ext>` so they never collide.

---

## Safety

- **Dry run by default.** Nothing is written without `--commit`.
- **Never deletes**, **never overwrites** — conflicts become versions.
- **Refuses** to run if the destination is missing or is inside the source.
- **Never follows symlinks** (avoids loops).
- **Skips** by default: `node_modules`, `.git`, `.cache`,
  `.local/share/Trash`, `.thumbnails`, `.gvfs` — add more with
  `--exclude a,b,c`.

Content comparison is exact: when two files have the same size bgit still
compares their hashes, because files written moments apart can share a
timestamp — trusting timestamps alone would silently skip a changed file.

---

## Examples

```bash
# back up your home to a mounted NAS, previewing first
bgit sync --src ~ --dst /mnt/nas/my_home_backup
bgit sync --src ~ --dst /mnt/nas/my_home_backup --commit

# back up to an SD card
bgit sync --src ~/Documents --dst /media/$USER/UNTITLED/backup --commit

# snapshot your photos to Nutstore as a compressed archive
bgit archive --src ~/Photos --dst ~/Nutstore/backups --format tar.zst --commit
```

---

## Install

```bash
git clone <this repo> bgit
cd bgit
npm link          # optional: puts `bgit` on your PATH
# or run it directly
node bin/bgit.js --help
# or start via npm (pass CLI arguments after --)
npm start
npm start -- sync --src ~/Documents --dst /mnt/nas/backups
```

Requires Node.js 18+ (Node 22+ for `tar.zst`).

## Test

```bash
npm run selftest
```

Creates fixtures, runs the sync engine (including idempotency and version
counting), then builds **every** archive format and verifies each one by
extracting it with the system tools and comparing byte-for-byte.

## Layout

```
bin/bgit.js          CLI entry
src/cli.js           commands + argument parsing
src/sync.js          the versioned merge engine
src/archive.js       archive mode (format dispatch)
src/formats/tar.js   tar writer (ustar + PAX for long paths)
src/formats/zip.js   zip writer (UTF-8 names + Info-ZIP unicode field)
src/storage.js       SD / NAS / cloud / disk detection
src/extract.js       unpacking via system tar/unzip
src/report.js        run reports
src/util.js          walk, hashing, retries, version helpers
tools/selftest.js    end-to-end tests
```
