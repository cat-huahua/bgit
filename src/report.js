'use strict';

const fsp = require('fs').promises;
const path = require('path');
const { stamp, fmtTime } = require('./util');
const { REPORT_PREFIX } = require('./sync');

/**
 * Write a human readable run report into the destination.
 * @returns {Promise<string>} the report path
 */
async function writeReport(dst, info) {
  const { src, dstKind, mode, plan, actions, archive, commit } = info;
  const lines = [];
  lines.push('bgit (backup git) report');
  lines.push('');
  lines.push(`when        : ${new Date().toString()}`);
  lines.push(`from        : ${src}`);
  lines.push(`to          : ${dst}`);
  if (dstKind) lines.push(`storage     : ${dstKind.label}${dstKind.fstype ? ` (${dstKind.fstype})` : ''}`);
  lines.push(`mode        : ${mode}${commit ? '' : ' [DRY RUN - nothing written]'}`);
  lines.push('');
  if (plan) {
    lines.push(
      `summary     : unchanged=${plan.unchanged}  added(.NA)=${plan.added.length}  ` +
        `versioned(.vN)=${plan.modified.length}  deleted(.D)=${plan.deleted.length}`
    );
    lines.push('');
  }
  if (archive) {
    lines.push(`archive     : ${archive.format} -> ${path.basename(archive.path)} (${archive.count} files)`);
    lines.push('');
  }
  lines.push('marks: A=new (.NA)   M=conflict (.vN)   D=gone from source (.D)');
  lines.push('time = last modified time of the source file (or of the stored copy for D)');
  lines.push('');
  lines.push('mark  time                 file  ->  stored as');
  lines.push('-'.repeat(100));
  for (const a of actions || []) {
    if (a.mark === 'M') {
      lines.push(`M     ${fmtTime(a.when)}  ${a.rel}`);
      if (a.old) lines.push(`                                old -> ${a.old}`);
      lines.push(`                                new -> ${a.result}`);
    } else {
      lines.push(`${a.mark}     ${fmtTime(a.when)}  ${a.rel}  ->  ${a.result}`);
    }
  }
  if (!actions || actions.length === 0) lines.push('(nothing to do)');
  lines.push('');

  const text = lines.join('\n');
  if (!commit) return { path: null, text };

  const file = path.join(dst, `${REPORT_PREFIX}${stamp()}.txt`);
  await fsp.writeFile(file, text, 'utf8');
  return { path: file, text };
}

module.exports = { writeReport };
