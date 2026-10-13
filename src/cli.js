'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { describeStorage, defaultsFor } = require('./storage');
const { buildPlan, applyPlan, previewActions } = require('./sync');
const { createArchive, normalizeFormat, formatList, availableFormats } = require('./archive');
const { writeReport } = require('./report');
const { extractArchive } = require('./extract');
const { human, stamp } = require('./util');

const VERSION = require('../package.json').version;

const HELP = `
bgit ${VERSION} - versioned backups for any mounted storage (SD / NAS / disk / cloud)

USAGE
  bgit sync    --src DIR --dst DIR [options]     versioned merge (default)
  bgit archive --src DIR --dst DIR [options]     compress DIR into one file
  bgit extract ARCHIVE --dst DIR                 unpack an archive
  bgit info    --dst DIR                         show storage type / what's there
  bgit formats                                   list archive formats available here

SYNC OPTIONS
  --src DIR            source folder (the "new" copy)          [default: ~]
  --dst DIR            backup destination (any mounted path)   [required]
  --commit             actually write (WITHOUT THIS IT IS A DRY RUN)
  --exclude A,B,C      extra names/paths to skip
  --no-report          don't write a report file
  --quiet              less output

ARCHIVE OPTIONS
  --archive            after syncing, also write an archive
  --archive-only       ONLY write an archive (skip the versioned sync)
  --format FMT         ${'{'}${formatList().join(',')}${'}'}          [default: zip]
  --name NAME          archive base name                       [default: folder name]
  --extract-to DIR     unpack a freshly made archive (sanity check)

EXAMPLES
  bgit sync    --src ~/Documents --dst /media/sdcard/backup --commit
  bgit archive --src ~/Photos --dst /mnt/nas/backups --format tar.gz --commit
  bgit archive --src ~/Photos --dst /mnt/nas/backups --format zip --archive-only --commit
  bgit extract /mnt/nas/backups/Photos-20260912-153000.tar.gz --dst ~/restore

NOTES
  * bgit NEVER deletes and NEVER overwrites.
      identical content          -> skipped
      same file, changed content -> old becomes <name>.v1, new becomes <name>.v2 (then .v3...)
      only in source             -> stored as <name>.NA   (newly added)
      only in destination        -> renamed <name>.D      (deleted from source)
  * Dry run is the default. Nothing is written without --commit.
  * Works the same on SD cards, NAS shares, USB disks and cloud mounts
    (Nutstore, rclone, WebDAV...). Retries are raised automatically on
    network/cloud storage, which is often flaky.
`;

// ---------------------------------------------------------------------------
// tiny arg parser
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { _: [], excludes: [] };
  const takesValue = new Set([
    '--src', '--dst', '--format', '--name', '--exclude', '--extract-to',
    '--name', '--report-dir', '--archive-dir',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') opts.commit = true;
    else if (a === '--archive') opts.archive = true;
    else if (a === '--archive-only') { opts.archive = true; opts.archiveOnly = true; }
    else if (a === '--no-report') opts.report = false;
    else if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--version' || a === '-v') opts.version = true;
    else if (takesValue.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      if (a === '--exclude') opts.excludes.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
      else opts[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function expand(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const DEFAULT_EXCLUDES = ['node_modules', '.git', '.cache', '.local/share/Trash', '.thumbnails', '.gvfs'];

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
async function cmdSync(opts, say) {
  if (!opts.dst) throw new Error('sync needs --dst DIR');
  const src = path.resolve(expand(opts.src || os.homedir()));
  const dst = path.resolve(expand(opts.dst));
  const commit = !!opts.commit;

  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`source is not a folder: ${src}`);
  if (!fs.existsSync(dst) || !fs.statSync(dst).isDirectory()) {
    throw new Error(`destination is not a folder: ${dst}\n(is it mounted? bgit will not create it for you)`);
  }
  if (path.resolve(dst).startsWith(path.resolve(src) + path.sep)) {
    throw new Error('destination is inside the source - refusing to avoid recursion');
  }

  const storage = describeStorage(dst);
  const excludes = [...DEFAULT_EXCLUDES, ...opts.excludes];

  say(`bgit sync`);
  say(`  from    : ${src}`);
  say(`  to      : ${dst}   [${storage.label}${storage.fstype ? ', ' + storage.fstype : ''}]`);
  say(`  mode    : ${commit ? 'COMMIT (changes WILL be written)' : 'DRY RUN (nothing will change)'}`);
  say('');

  const plan = await buildPlan({
    src,
    dst,
    excludes,
    onProgress: (p) => {
      if (!opts.quiet && p.phase === 'compare' && p.done % 1000 === 0) say(`  scanning ${p.done}/${p.total}`);
    },
  });

  say(`  unchanged            : ${plan.unchanged}`);
  say(`  added     -> .NA     : ${plan.added.length}`);
  say(`  changed   -> .vN     : ${plan.modified.length}`);
  say(`  deleted   -> .D      : ${plan.deleted.length}`);
  say(`  already marked       : ${plan.skippedMarked}`);
  say('');

  const actions = commit
    ? await applyPlan(plan, { retries: defaultsFor(storage.kind).retries, onProgress: () => {} })
    : previewActions(plan);

  if (opts.report !== false) {
    const { path: reportPath } = await writeReport(dst, {
      src, dst, dstKind: storage, mode: 'sync', plan, actions, commit,
    });
    say(commit ? `  report  : ${reportPath}` : `  report  : (dry run - nothing written)`);
  }

  say('');
  say(commit ? 'Done. Nothing was deleted or overwritten.' : 'This was a DRY RUN. Re-run with --commit to apply.');
  return { plan, actions };
}

async function cmdArchive(opts, say) {
  if (!opts.dst) throw new Error('archive needs --dst DIR (where to put the file)');
  const src = path.resolve(expand(opts.src || os.homedir()));
  const dst = path.resolve(expand(opts.dst));
  const commit = !!opts.commit;
  const format = normalizeFormat(opts.format || 'zip');
  if (!format) throw new Error(`unknown --format "${opts.format}". Available: ${formatList().join(', ')}`);

  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`source is not a folder: ${src}`);
  if (!fs.existsSync(dst) || !fs.statSync(dst).isDirectory()) {
    throw new Error(`destination is not a folder: ${dst}\n(is it mounted?)`);
  }

  const storage = describeStorage(dst);
  say('bgit archive');
  say(`  from    : ${src}`);
  say(`  to      : ${dst}   [${storage.label}]`);
  say(`  format  : ${format}`);
  say(`  mode    : ${commit ? 'COMMIT' : 'DRY RUN (no file written)'}`);
  say('');

  if (!commit) {
    const dryName = `${opts.name || path.basename(src)}-${stamp()}${require('./archive').FORMATS[format].ext}`;
    say(`  would write: ${path.join(dst, dryName)}`);
    say('');
    say('This was a DRY RUN. Re-run with --commit to create the archive.');
    return { path: null };
  }

  const res = await createArchive({
    src,
    outDir: dst,
    name: opts.name,
    format,
    excludes: [...DEFAULT_EXCLUDES, ...opts.excludes],
    onProgress: (p) => {
      if (p.phase === 'collect') say(`  collecting ${p.count} files...`);
      if (p.phase === 'archive-done') say(`  done: ${human(p.size)} (${p.count} files)`);
      if (p.phase === 'skipped') {
        say(`  skipped : ${p.files.length} file(s) gone or unreadable while packing`);
        for (const s of p.files.slice(0, 10)) say(`            ${s.rel}  (${s.reason})`);
        if (p.files.length > 10) say(`            ... and ${p.files.length - 10} more`);
      }
    },
  });
  say(`  wrote   : ${res.path}`);
  return res;
}

async function cmdExtract(opts, say) {
  const archivePath = opts._[1];
  if (!archivePath) throw new Error('extract needs an archive path: bgit extract FILE --dst DIR');
  const dest = path.resolve(expand(opts.dst || '.'));
  say(`extracting ${archivePath} -> ${dest}`);
  await extractArchive(path.resolve(expand(archivePath)), dest);
  say('done.');
}

async function cmdInfo(opts, say) {
  if (!opts.dst) throw new Error('info needs --dst DIR');
  const dst = path.resolve(expand(opts.dst));
  const storage = describeStorage(dst);
  say(`path      : ${dst}`);
  say(`exists    : ${fs.existsSync(dst)}`);
  say(`storage   : ${storage.label}`);
  if (storage.fstype) say(`filesystem: ${storage.fstype}`);
  if (storage.device) say(`device    : ${storage.device}`);
  if (storage.mountpoint) say(`mounted at: ${storage.mountpoint}`);
  const d = defaultsFor(storage.kind);
  say(`defaults  : retries=${d.retries} concurrency=${d.concurrency}`);
}

async function cmdFormats(_opts, say) {
  say('format      extension     needs');
  say('-'.repeat(46));
  const navail = new Set(availableFormats());
  for (const f of formatList()) {
    const def = require('./archive').FORMATS[f];
    const needs = def.kind === 'tar+external' ? def.bin : '(built in)';
    say(`${f.padEnd(12)}${def.ext.padEnd(14)}${needs}${navail.has(f) ? '' : '   [NOT INSTALLED]'}`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(argv) {
  const say = (s) => console.log(s);
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error(HELP);
    return 2;
  }
  if (opts.version) {
    console.log(VERSION);
    return 0;
  }

  const cmd = opts._[0];
  if (opts.help || !cmd) {
    console.log(HELP);
    return 0;
  }

  try {
    switch (cmd) {
      case 'sync': {
        if (!opts.archiveOnly) await cmdSync(opts, say);
        if (opts.archive) {
          say('');
          await cmdArchive(opts, say);
        }
        return 0;
      }
      case 'archive':
        await cmdArchive(opts, say);
        return 0;
      case 'extract':
        await cmdExtract(opts, say);
        return 0;
      case 'info':
        await cmdInfo(opts, say);
        return 0;
      case 'formats':
        await cmdFormats(opts, say);
        return 0;
      default:
        console.error(`Unknown command: ${cmd}`);
        console.log(HELP);
        return 2;
    }
  } catch (err) {
    console.error(`\nbgit: ${err.message}`);
    return 1;
  }
}

module.exports = { main, parseArgs, cmdSync, cmdArchive, cmdExtract, cmdInfo, DEFAULT_EXCLUDES };
