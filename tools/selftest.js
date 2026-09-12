'use strict';

/**
 * bgit self test - no internet, no external deps beyond tar/unzip which are
 * standard. Verifies the sync engine AND every archive format (create, verify
 * with the system tools, then extract and compare contents).
 *
 * Run: node tools/selftest.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const { buildPlan, applyPlan, previewActions } = require('../src/sync');
const { createArchive, formatList, availableFormats } = require('../src/archive');
const { extractArchive } = require('../src/extract');
const { detectStorage, describeStorage, classifyFstype } = require('../src/storage');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✔ ${name}`);
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bgit-${tag}-`));
}

// ---------------------------------------------------------------------------
async function testSync() {
  console.log('\nsync engine');
  const base = tmpdir('sync');
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  fs.mkdirSync(path.join(src, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(dst, 'docs'), { recursive: true });

  const same = 'identical';
  fs.writeFileSync(path.join(src, 'docs/same.txt'), same);
  fs.writeFileSync(path.join(dst, 'docs/same.txt'), same);
  const t = new Date('2026-01-01T10:00:00Z');
  fs.utimesSync(path.join(src, 'docs/same.txt'), t, t);
  fs.utimesSync(path.join(dst, 'docs/same.txt'), t, t);

  fs.writeFileSync(path.join(dst, 'note.txt'), 'OLD');
  fs.writeFileSync(path.join(src, 'note.txt'), 'NEW');
  fs.writeFileSync(path.join(src, 'fresh.txt'), 'brand new');
  fs.writeFileSync(path.join(dst, 'gone.txt'), 'removed later');
  // same size, different bytes -> must still be detected
  fs.writeFileSync(path.join(dst, 'swap.bin'), 'AAAA');
  fs.writeFileSync(path.join(src, 'swap.bin'), 'BBBB');

  let plan = await buildPlan({ src, dst, excludes: [] });
  assert.strictEqual(plan.unchanged, 1, 'unchanged counted');
  assert.strictEqual(plan.added.length, 1, 'one added');
  assert.strictEqual(plan.modified.length, 2, 'two modified (note + same-size swap)');
  assert.strictEqual(plan.deleted.length, 1, 'one deleted');
  ok('classifies unchanged / added / modified / deleted');

  const actions = await applyPlan(plan, { retries: 1 });
  assert.ok(fs.existsSync(path.join(dst, 'fresh.txt.NA')), 'new file stored as .NA');
  assert.ok(fs.existsSync(path.join(dst, 'note.txt.v1')), 'old version kept as .v1');
  assert.strictEqual(fs.readFileSync(path.join(dst, 'note.txt.v2'), 'utf8'), 'NEW', 'new version at .v2');
  assert.strictEqual(fs.readFileSync(path.join(dst, 'note.txt.v1'), 'utf8'), 'OLD', '.v1 holds the old content');
  assert.ok(fs.existsSync(path.join(dst, 'gone.txt.D')), 'deleted file only renamed to .D');
  assert.ok(fs.existsSync(path.join(dst, 'swap.bin.v1')), 'same-size-different-content detected');
  ok('applies: .NA / .v1+.v2 / .D');

  // idempotent
  plan = await buildPlan({ src, dst, excludes: [] });
  assert.strictEqual(plan.added.length, 0, 'no re-adding on second run');
  assert.strictEqual(plan.modified.length, 0, 'no re-versioning on second run');
  assert.strictEqual(plan.deleted.length, 0, 'no re-deleting on second run');
  ok('is idempotent (second run is a no-op)');

  // third change -> .v3
  fs.writeFileSync(path.join(src, 'note.txt'), 'THIRD');
  plan = await buildPlan({ src, dst, excludes: [] });
  await applyPlan(plan, { retries: 1 });
  assert.ok(fs.existsSync(path.join(dst, 'note.txt.v3')), 'third version lands at .v3');
  ok('version numbers count up (.v1 -> .v2 -> .v3)');

  fs.rmSync(base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
async function testFormats() {
  console.log('\narchive formats');
  const base = tmpdir('arch');
  const src = path.join(base, 'data');
  const out = path.join(base, 'out');
  fs.mkdirSync(path.join(src, 'nested/deep'), { recursive: true });
  fs.mkdirSync(out, { recursive: true });

  fs.writeFileSync(path.join(src, 'hello.txt'), 'hello bgit\n'.repeat(500));
  fs.writeFileSync(path.join(src, 'nested/deep/blob.bin'), Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)));
  fs.writeFileSync(path.join(src, 'unicode-名前.txt'), 'unicode filename\n');
  // long path (>100 chars exercises tar prefix, >255 exercises PAX)
  const longDir = path.join(src, 'a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80));
  fs.mkdirSync(longDir, { recursive: true });
  fs.writeFileSync(path.join(longDir, 'deep.txt'), 'deep file\n');
  // even longer - beyond ustar entirely, must use a PAX header
  const longerDir = path.join(src, 'd'.repeat(60), 'e'.repeat(60), 'f'.repeat(60), 'g'.repeat(60));
  fs.mkdirSync(longerDir, { recursive: true });
  fs.writeFileSync(path.join(longerDir, 'deeper.txt'), 'deeper file\n');
  // empty file
  fs.writeFileSync(path.join(src, 'empty.txt'), '');

  const have = new Set(availableFormats());
  const toTest = formatList().filter((f) => have.has(f));
  const skipped = formatList().filter((f) => !have.has(f));

  for (const format of toTest) {
    const res = await createArchive({ src, outDir: out, name: 'data', format });
    assert.ok(fs.existsSync(res.path), `${format}: file created`);
    assert.ok(res.size > 0, `${format}: non-empty`);

    // extract with the system tools into a fresh dir and compare
    const dest = path.join(base, `x-${format.replace(/[^a-z0-9]/gi, '_')}`);
    await extractArchive(res.path, dest);

    const cmp = (rel, expect) => {
      const p = path.join(dest, rel);
      assert.ok(fs.existsSync(p), `${format}: ${rel} extracted`);
      if (expect !== undefined) {
        assert.strictEqual(fs.readFileSync(p).toString('binary'), expect, `${format}: ${rel} content matches`);
      }
    };
    cmp('hello.txt', fs.readFileSync(path.join(src, 'hello.txt')).toString('binary'));
    cmp('nested/deep/blob.bin', fs.readFileSync(path.join(src, 'nested/deep/blob.bin')).toString('binary'));
    cmp('unicode-名前.txt');
    cmp(path.relative(src, path.join(longDir, 'deep.txt')));
    cmp(path.relative(src, path.join(longerDir, 'deeper.txt')));
    cmp('empty.txt', '');

    // verify integrity with the native tool as well
    if (format === 'zip') {
      execFileSync('unzip', ['-t', res.path], { stdio: 'ignore' });
    } else {
      execFileSync('tar', ['-tf', res.path], { stdio: 'ignore' });
    }
    ok(`${format.padEnd(9)} create + verify + extract round-trip`);
  }

  if (skipped.length) {
    console.log(`  (skipped, tool not installed: ${skipped.join(', ')})`);
  }
  fs.rmSync(base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
function testStorage() {
  console.log('\nstorage detection');
  assert.strictEqual(classifyFstype('cifs', '//nas/share'), 'nas');
  assert.strictEqual(classifyFstype('nfs4', 'server:/x'), 'nas');
  assert.strictEqual(classifyFstype('vfat', '/dev/mmcblk0p1'), 'sd');
  assert.strictEqual(classifyFstype('exfat', '/dev/sdb1'), 'sd');
  assert.strictEqual(classifyFstype('fuse.rclone', 'rclone'), 'cloud');
  assert.strictEqual(classifyFstype('ext4', '/dev/nvme0n1p2'), 'disk');
  ok('classifies nas / sd / cloud / disk from fstype');

  const d = describeStorage(os.tmpdir());
  assert.ok(d.kind && d.label, 'describe returns a kind and label');
  ok(`detects this machine's temp dir as: ${d.label}`);
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('bgit self test');
  await testSync();
  await testFormats();
  testStorage();
  console.log(`\nAll ${passed} checks passed.`);
}

main().catch((err) => {
  console.error('\nFAILED:', err && err.message ? err.message : err);
  console.error(err && err.stack);
  process.exit(1);
});
