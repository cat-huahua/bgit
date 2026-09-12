'use strict';

/**
 * The versioned merge engine.
 *
 * Rules (never deletes, never overwrites):
 *   identical content ............... nothing
 *   same file, different content .... old -> <name>.v1, incoming -> <name>.v2 (then .v3...)
 *   only in the source .............. copied as <name>.NA
 *   only in the destination ......... renamed to <name>.D
 *
 * Idempotent: running it twice does nothing the second time.
 */

const fsp = require('fs').promises;
const path = require('path');
const {
  walk,
  sameContent,
  splitVersion,
  highestVersion,
  withRetry,
  ensureDir,
} = require('./util');

const REPORT_PREFIX = '_BGIT-REPORT-';
const isMarked = (name) => name.endsWith('.NA') || name.endsWith('.D') || name.startsWith(REPORT_PREFIX);

async function buildPlan({ src, dst, excludes = [], onProgress = () => {} }) {
  onProgress({ phase: 'scan', message: 'listing source' });
  const srcFiles = await walk(src, excludes);
  onProgress({ phase: 'scan', message: 'listing destination' });
  const dstFiles = await walk(dst, excludes);

  const plan = { modified: [], added: [], deleted: [], unchanged: 0, skippedMarked: 0 };
  let seen = 0;

  for (const [rel, s] of srcFiles) {
    seen += 1;
    if (seen % 200 === 0) onProgress({ phase: 'compare', done: seen, total: srcFiles.size });

    const base = path.basename(rel);
    if (isMarked(base)) {
      plan.skippedMarked += 1;
      continue;
    }

    const srcPath = path.join(src, rel);
    const dstPath = path.join(dst, rel);
    const dir = path.dirname(dstPath);
    const hi = highestVersion(dir, base);

    // Newest counterpart on the destination (plain, or the .NA/.vN we left before).
    let counterpartRel = null;
    let counterpartPath = null;
    if (hi > 0) {
      counterpartRel = `${rel}.v${hi}`;
      counterpartPath = `${dstPath}.v${hi}`;
    } else if (dstFiles.has(`${rel}.NA`)) {
      counterpartRel = `${rel}.NA`;
      counterpartPath = `${dstPath}.NA`;
    } else if (dstFiles.has(rel)) {
      counterpartRel = rel;
      counterpartPath = dstPath;
    }

    if (!counterpartRel) {
      plan.added.push({ rel, src: srcPath, targetRel: `${rel}.NA`, target: `${dstPath}.NA`, size: s.size, mtimeMs: s.mtimeMs });
      continue;
    }

    const d = dstFiles.get(counterpartRel);
    const same = await sameContent(srcPath, s, d, counterpartPath);
    if (same) {
      plan.unchanged += 1;
      continue;
    }

    let renameFrom = null;
    let renameTo = null;
    let target;
    let targetRel;
    if (hi === 0) {
      renameFrom = counterpartPath;
      renameTo = `${dstPath}.v1`;
      target = `${dstPath}.v2`;
      targetRel = `${rel}.v2`;
    } else {
      target = `${dstPath}.v${hi + 1}`;
      targetRel = `${rel}.v${hi + 1}`;
    }
    plan.modified.push({
      rel,
      src: srcPath,
      renameFrom,
      renameTo,
      oldRel: hi === 0 ? `${rel}.v1` : counterpartRel,
      target,
      targetRel,
      srcMtimeMs: s.mtimeMs,
    });
  }

  for (const [rel, d] of dstFiles) {
    const base = path.basename(rel);
    if (isMarked(base) || splitVersion(base).v > 0) {
      plan.skippedMarked += 1;
      continue;
    }
    if (!srcFiles.has(rel)) {
      plan.deleted.push({
        rel,
        dst: path.join(dst, rel),
        dstMarked: path.join(dst, rel) + '.D',
        targetRel: `${rel}.D`,
        mtimeMs: d.mtimeMs,
        size: d.size,
      });
    }
  }
  return plan;
}

function previewActions(plan) {
  return [
    ...plan.added.map((a) => ({ mark: 'A', rel: a.rel, result: a.targetRel, when: a.mtimeMs })),
    ...plan.modified.map((m) => ({ mark: 'M', rel: m.rel, old: m.oldRel, result: m.targetRel, when: m.srcMtimeMs })),
    ...plan.deleted.map((d) => ({ mark: 'D', rel: d.rel, result: d.targetRel, when: d.mtimeMs })),
  ];
}

async function applyPlan(plan, { retries = 3, onProgress = () => {} } = {}) {
  const actions = [];
  const r = (fn, label) => withRetry(fn, { tries: retries, label });

  for (const a of plan.added) {
    await r(() => ensureDir(path.dirname(a.target)));
    await r(() => fsp.copyFile(a.src, a.target), `copy ${a.rel}`);
    actions.push({ mark: 'A', rel: a.rel, result: a.targetRel, when: a.mtimeMs });
    onProgress({ phase: 'apply', message: `+ ${a.rel}` });
  }

  for (const m of plan.modified) {
    if (m.renameFrom) await r(() => fsp.rename(m.renameFrom, m.renameTo), `version ${m.rel}`);
    await r(() => ensureDir(path.dirname(m.target)));
    await r(() => fsp.copyFile(m.src, m.target), `copy ${m.rel}`);
    actions.push({ mark: 'M', rel: m.rel, old: m.oldRel, result: m.targetRel, when: m.srcMtimeMs });
    onProgress({ phase: 'apply', message: `~ ${m.rel}` });
  }

  for (const d of plan.deleted) {
    await r(() => fsp.rename(d.dst, d.dstMarked), `mark deleted ${d.rel}`);
    actions.push({ mark: 'D', rel: d.rel, result: d.targetRel, when: d.mtimeMs });
    onProgress({ phase: 'apply', message: `- ${d.rel}` });
  }

  return actions;
}

module.exports = { buildPlan, applyPlan, previewActions, REPORT_PREFIX, isMarked };
