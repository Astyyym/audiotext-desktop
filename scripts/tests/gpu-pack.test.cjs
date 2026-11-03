'use strict';
// GPU pack install tests: real temp zip, real sha256, real PowerShell extraction.
// Covers: sha mismatch rejected, size mismatch rejected, missing file rejected,
// nested cuda/ folder flattened, reinstall replaces directory, atomic temp cleanup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gp = require('../../app/gpu-pack');

function makeZip(root, layout) {
  // layout: { 'name': Buffer } flat OR { 'cuda/name': Buffer } nested
  const src = path.join(root, 'src-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(src, { recursive: true });
  for (const [rel, buf] of Object.entries(layout)) {
    const dest = path.join(src, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
  const zip = path.join(root, 'pack-' + Math.random().toString(36).slice(2) + '.zip');
  const script = 'Compress-Archive -Path (Join-Path $env:ATD_SRC "*") -DestinationPath $env:ATD_ZIP -Force';
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: Object.assign({}, process.env, { ATD_SRC: src, ATD_ZIP: zip }) });
  return zip;
}

function tmpRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atd-gpu-pack-'));
  assert.equal(path.dirname(root), os.tmpdir());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const DLLS = {
  'cublas64_12.dll': Buffer.alloc(2048, 1),
  'cublasLt64_12.dll': Buffer.alloc(4096, 2),
};

test('sha256 / size / success / overwrite semantics', async (t) => {
  const root = tmpRoot(t);
  const zip = makeZip(root, DLLS);
  const sha = await gp.sha256File(zip);
  const size = fs.statSync(zip).size;
  const dest = path.join(root, 'gpu', 'cuda');

  await assert.rejects(gp.installFromZip(zip, dest, { size, sha256: 'deadbeef' }), /SHA256/);
  assert.equal(fs.existsSync(path.join(dest, 'cublas64_12.dll')), false, 'no partial install on bad sha');

  await assert.rejects(gp.installFromZip(zip, dest, { size: size + 1, sha256: sha }), /大小不符/);
  assert.equal(fs.existsSync(path.join(dest, 'cublas64_12.dll')), false, 'no install on bad size');

  await gp.installFromZip(zip, dest, { size, sha256: sha });
  assert.equal(gp.isInstalled(dest), true);
  assert.equal(fs.readFileSync(path.join(dest, 'cublas64_12.dll')).length, 2048);

  // reinstall replaces the whole directory (stale files removed)
  fs.writeFileSync(path.join(dest, 'stale.txt'), 'x');
  await gp.installFromZip(zip, dest, { size, sha256: sha });
  assert.equal(fs.existsSync(path.join(dest, 'stale.txt')), false);
});

test('missing required DLL is rejected and leaves no install', async (t) => {
  const root = tmpRoot(t);
  const zip = makeZip(root, { 'cublas64_12.dll': Buffer.alloc(1024, 3) }); // missing cublasLt
  const dest = path.join(root, 'gpu', 'cuda');
  await assert.rejects(gp.installFromZip(zip, dest, {}), /缺少文件/);
  assert.equal(fs.existsSync(path.join(dest, 'cublas64_12.dll')), false);
});

test('nested cuda/ folder inside zip is flattened into dest', async (t) => {
  const root = tmpRoot(t);
  const zip = makeZip(root, {
    'cuda/cublas64_12.dll': Buffer.alloc(1024, 4),
    'cuda/cublasLt64_12.dll': Buffer.alloc(2048, 5),
  });
  const dest = path.join(root, 'gpu', 'cuda');
  await gp.installFromZip(zip, dest, {});
  assert.equal(gp.isInstalled(dest), true);
  assert.equal(fs.readFileSync(path.join(dest, 'cublasLt64_12.dll')).length, 2048);
});

test('isInstalled / dirSizeBytes reflect contents', async (t) => {
  const root = tmpRoot(t);
  assert.equal(gp.isInstalled(path.join(root, 'nope')), false);
  const dir = path.join(root, 'cuda');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cublas64_12.dll'), Buffer.alloc(100, 6));
  assert.equal(gp.isInstalled(dir), false, 'missing second dll');
  fs.writeFileSync(path.join(dir, 'cublasLt64_12.dll'), Buffer.alloc(200, 7));
  assert.equal(gp.isInstalled(dir), true);
  assert.equal(gp.dirSizeBytes(dir), 300);
});
