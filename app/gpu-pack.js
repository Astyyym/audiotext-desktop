'use strict';
/**
 * GPU 加速包（CUDA 12 运行库）本地安装工具。
 * 纯 Node 实现，不依赖 Electron，便于单元测试：
 *  - sha256 校验
 *  - 用 Windows 自带 PowerShell Expand-Archive 解压 zip（应用仅面向 Windows）
 *  - 解压到临时目录 -> 校验 -> 原子替换到目标目录
 * 只关心 cublas64_12.dll / cublasLt64_12.dll 两个文件（见 findings F18）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const REQUIRED_FILES = ['cublas64_12.dll', 'cublasLt64_12.dll'];

function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch (e) { return false; }
}

function sha256File(file, onProgress) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let read = 0;
    const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (chunk) => { hash.update(chunk); read += chunk.length; if (onProgress) onProgress(read); });
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function isInstalled(dir, files = REQUIRED_FILES) {
  if (!dir) return false;
  try {
    return files.every((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return stat.isFile() && stat.size > 0;
    });
  } catch (e) { return false; }
}

function dirSizeBytes(dir) {
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const stat = fs.statSync(path.join(dir, name));
      if (stat.isFile()) total += stat.size;
    }
  } catch (e) { /* ignore */ }
  return total;
}

function findFile(root, name) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return null; }
  for (const entry of entries) {
    const p = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return p;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) { const found = findFile(path.join(root, entry.name), name); if (found) return found; }
  }
  return null;
}

function checkZip(zipPath, expected) {
  let stat;
  try { stat = fs.statSync(zipPath); } catch (e) { throw new Error('找不到安装包：' + zipPath); }
  if (!stat.isFile() || stat.size === 0) throw new Error('安装包为空或不是文件：' + zipPath);
  if (expected && expected.size && stat.size !== expected.size) {
    throw new Error('安装包大小不符（' + stat.size + '/' + expected.size + '）');
  }
  return stat.size;
}

async function verifyZip(zipPath, expected) {
  const size = checkZip(zipPath, expected);
  if (expected && expected.sha256) {
    const got = await sha256File(zipPath);
    if (got.toLowerCase() !== String(expected.sha256).toLowerCase()) {
      throw new Error('安装包校验失败（SHA256 不符），文件可能损坏或被篡改');
    }
  }
  return size;
}

function extractArchive(archivePath, destDir, timeoutMs = 300000) {
  // .7z -> Windows built-in tar.exe (bsdtar, can read 7z; no extra dependency, best compression).
  // .zip -> PowerShell Expand-Archive.
  if (/\.7z$/i.test(archivePath)) {
    return new Promise((resolve, reject) => {
      execFile('tar.exe', ['-xf', archivePath, '-C', destDir], { windowsHide: true, timeout: timeoutMs },
        (err, _stdout, stderr) => err ? reject(new Error('解压失败：' + ((stderr || '').trim() || err.message))) : resolve());
    });
  }
  return new Promise((resolve, reject) => {
    const script = 'Expand-Archive -LiteralPath $env:ATD_ZIP -DestinationPath $env:ATD_DEST -Force';
    const env = Object.assign({}, process.env, { ATD_ZIP: archivePath, ATD_DEST: destDir });
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, env, timeout: timeoutMs },
      (err, _stdout, stderr) => err ? reject(new Error('解压失败：' + ((stderr || '').trim() || err.message))) : resolve());
  });
}

/**
 * 校验 + 解压 + 原子安装。expected: { size?, sha256? }。
 * 目标目录已有内容会被整体替换（GPU 包是纯运行库，不承载用户数据）。
 */
async function installFromZip(zipPath, destDir, expected, opts = {}) {
  const files = opts.files || REQUIRED_FILES;
  await verifyZip(zipPath, expected || {});
  const parent = path.dirname(destDir);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, '.gpu-tmp-' + process.pid + '-' + Date.now());
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    await extractArchive(zipPath, tmp);
    for (const name of files) {
      if (fileExists(path.join(tmp, name))) continue;
      const found = findFile(tmp, name);
      if (!found) throw new Error('安装包缺少文件：' + name);
      fs.copyFileSync(found, path.join(tmp, name));
    }
    if (!isInstalled(tmp, files)) throw new Error('解压后文件不完整');
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.renameSync(tmp, destDir);
    if (!isInstalled(destDir, files)) throw new Error('安装后校验失败');
    return { dir: destDir, files, sizeBytes: dirSizeBytes(destDir) };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

module.exports = {
  REQUIRED_FILES,
  sha256File,
  isInstalled,
  dirSizeBytes,
  findFile,
  verifyZip,
  extractArchive,
  installFromZip,
};
