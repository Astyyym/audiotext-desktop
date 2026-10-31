'use strict';
/**
 * AudioText Desktop · Electron 主进程
 * 职责：窗口、IPC、设置/历史/术语持久化、通过 stdio(JSON 行) 调用引擎并回传事件。
 */
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const loadConfig = require('./config');

const MEDIA_EXT = [
  'm4a', 'mp4', 'mov', 'm4v', 'wav', 'mp3', 'aac', 'flac', 'ogg', 'opus', 'amr',
  'wma', 'aiff', 'aif', 'mkv', 'webm', 'avi', 'flv', 'wmv', '3gp', 'ts', 'm2ts',
  'rmvb', 'mpeg', 'mpg', 'asf', 'dv',
];

/**
 * 可下载模型清单（默认从魔搭 ModelScope 拉取 faster-whisper 的 CTranslate2 版本）。
 * 文件大小取自 ModelScope 仓库，用于进度百分比与完成校验。
 * 不再随安装包内置，安装后在「设置 → 模型」按需下载，或导入离线模型包。
 */
const MODEL_CATALOG = [
  {
    key: 'small', name: 'Small', desc: '最快 · 适合 CPU', repo: 'Systran/faster-whisper-small',
    files: [
      { path: 'config.json', size: 2370 },
      { path: 'tokenizer.json', size: 2203239 },
      { path: 'vocabulary.txt', size: 459861 },
      { path: 'model.bin', size: 483546902 },
    ],
  },
  {
    key: 'medium', name: 'Medium', desc: '均衡 · 比 small 准', repo: 'Systran/faster-whisper-medium',
    files: [
      { path: 'config.json', size: 2257 },
      { path: 'tokenizer.json', size: 2203239 },
      { path: 'vocabulary.txt', size: 459861 },
      { path: 'model.bin', size: 1527906378 },
    ],
  },
  {
    key: 'large-v3', name: 'Large-V3', desc: '最准 · 建议配 NVIDIA GPU', repo: 'Systran/faster-whisper-large-v3',
    files: [
      { path: 'config.json', size: 2394 },
      { path: 'tokenizer.json', size: 2480617 },
      { path: 'vocabulary.json', size: 1068114 },
      { path: 'preprocessor_config.json', size: 340 },
      { path: 'model.bin', size: 3087284237 },
    ],
  },
];
const MODELSCOPE_BASE = 'https://modelscope.cn/models';
function modelTotalBytes(def) { return def.files.reduce((a, f) => a + f.size, 0); }
const modelDownloads = new Map(); // key -> { cancelled, abortController }

const DEFAULT_SETTINGS = {
  device: 'auto',      // auto | gpu | cpu
  modelKey: 'auto',    // auto | small | medium | large-v3
  outDir: '',          // 空 = 源文件同目录/文字稿
  lang: 'zh',
  formats: 'txt,srt',
  termsEnabled: false,
  historyDir: '',      // 空 = 用户 AppData 默认位置
  aiPrompt: '你是一名面试复盘助手。下面这段文字是一场面试（或电话沟通）的语音转写稿，可能存在同音错别字，请结合上下文自动纠正。请只依据原文、不要编造，完成：\n1) 按流程列出面试官问过的【问题清单】（合并重复、改成规范问句）；\n2) 针对每个问题给出【回答要点】，原文没答或含糊的标注「未明确回答」；\n3) 单独整理【关键信息】：公司/项目/岗位、技术栈、薪资范围、到岗时间、工作地点、加班与出差等；\n4) 给出【复盘建议】：亮点与可改进处。\n请用中文分点输出，条理清晰。',
};

let win = null;
const children = new Map(); // taskId -> ChildProcess
let gpuCache = null;

/* ---------------- 持久化 ---------------- */
function dataFile(name) {
  return path.join(app.getPath('userData'), name);
}
function readJson(fp, def) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (e) {
    return def;
  }
}
function writeJson(fp, obj) {
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (e) { /* ignore */ }
}
function getSettings() {
  return Object.assign({}, DEFAULT_SETTINGS, readJson(dataFile('settings.json'), {}));
}
function saveSettings(patch) {
  const s = Object.assign(getSettings(), patch || {});
  writeJson(dataFile('settings.json'), s);
  return s;
}
function historyFile() {
  const s = getSettings();
  if (s.historyDir) {
    try { fs.mkdirSync(s.historyDir, { recursive: true }); } catch (e) { /* ignore */ }
    return path.join(s.historyDir, 'history.json');
  }
  return dataFile('history.json');
}
function getHistory() { const a = readJson(historyFile(), []); return Array.isArray(a) ? a : []; }
function addHistory(rec) { const a = getHistory(); a.unshift(rec); writeJson(historyFile(), a.slice(0, 300)); }
function getTerms() {
  const t = readJson(dataFile('terms.json'), null);
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    return { terms: Array.isArray(t.terms) ? t.terms : [], replace: t.replace && typeof t.replace === 'object' ? t.replace : {} };
  }
  return { terms: [], replace: {} };
}
function saveTerms(t) { writeJson(dataFile('terms.json'), { terms: (t && t.terms) || [], replace: (t && t.replace) || {} }); }

/* ---------------- 引擎调用基础设施 ---------------- */
function buildEnv(cfg) {
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });
  if (cfg.ffmpeg) env.FFMPEG = cfg.ffmpeg;
  if (cfg.ffprobe) env.FFPROBE = cfg.ffprobe;
  if (cfg.cudaDir && fs.existsSync(cfg.cudaDir)) env.ATD_CUDA_DIR = cfg.cudaDir;
  if (cfg.extraPath) env.PATH = cfg.extraPath + path.delimiter + (env.PATH || '');
  return env;
}
function engineInvocation(cfg, subArgs) {
  if (cfg.useEngineExe) {
    return { cmd: cfg.engineExe, args: subArgs.slice(), cwd: path.dirname(cfg.engineExe) };
  }
  return { cmd: cfg.python, args: ['-m', 'engine.cli'].concat(subArgs), cwd: cfg.engineRoot };
}
function modelRoot(cfg) {
  return cfg.packaged ? path.join(process.resourcesPath, 'models') : path.join(cfg.engineRoot, 'models');
}
function listModels(cfg) {
  const root = modelRoot(cfg);
  const out = [];
  try {
    if (fs.existsSync(root)) {
      for (const name of fs.readdirSync(root)) {
        const d = path.join(root, name);
        if (modelDirectoryInstalled(d, name)) {
          out.push({ key: name, sizeMB: Math.round(fs.statSync(path.join(d, 'model.bin')).size / 1048576) });
        }
      }
    }
  } catch (e) { /* ignore */ }
  const order = ['small', 'medium', 'large-v3'];
  out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return out;
}
function resolveModel(cfg, modelKey, gpu) {
  const root = modelRoot(cfg);
  const has = (k) => !!k && modelInstalled(cfg, k);
  let key = modelKey;
  if (!key || key === 'auto') {
    if (gpu && has('medium')) key = 'medium';
    else if (gpu && has('large-v3')) key = 'large-v3';
    else if (has('small')) key = 'small';
    else if (has('medium')) key = 'medium';
    else if (has('large-v3')) key = 'large-v3';
    else key = '';
  }
  if (has(key)) return { key, dir: path.join(root, key) };
  if (cfg.model && modelDirectoryInstalled(cfg.model, path.basename(cfg.model))) {
    return { key: path.basename(cfg.model), dir: cfg.model };
  }
  return { key: '', dir: '' };
}

/* ---------------- 模型目录 / 按需下载（魔搭 ModelScope） ---------------- */
function modelDir(cfg, key) { return path.join(modelRoot(cfg), key); }
// 离线包的元数据可来自不同转换版本，只检查必要文件，不要求其大小与下载站一致。
function modelFileUsable(file, expected = 0) {
  let stat;
  try { stat = fs.statSync(file); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  if (!stat.isFile() || stat.size === 0 || (expected && stat.size !== expected)) return false;
  if (/\.json(?:\.part)?$/.test(file)) {
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { if (e instanceof SyntaxError) return false; throw e; }
    return value !== null && typeof value === 'object';
  }
  return true;
}
function modelDirectoryInstalled(dir, key) {
  try {
    const def = MODEL_CATALOG.find((d) => d.key === key.replace(/^faster-whisper-/, ''));
    const weight = def && def.files.find((f) => f.path === 'model.bin');
    return modelFileUsable(path.join(dir, 'model.bin'), weight ? weight.size : 0)
      && modelFileUsable(path.join(dir, 'config.json'))
      && modelFileUsable(path.join(dir, 'tokenizer.json'))
      && (modelFileUsable(path.join(dir, 'vocabulary.txt')) || modelFileUsable(path.join(dir, 'vocabulary.json')));
  } catch (e) { return false; }
}
function modelInstalled(cfg, key) {
  return modelDirectoryInstalled(modelDir(cfg, key), key);
}
function getCatalog(cfg) {
  return MODEL_CATALOG.map((d) => {
    const total = modelTotalBytes(d);
    let sizeMB = 0;
    try { sizeMB = Math.round(fs.statSync(path.join(modelDir(cfg, d.key), 'model.bin')).size / 1048576); } catch (e) { sizeMB = 0; }
    return {
      key: d.key, name: d.name, desc: d.desc,
      totalMB: Math.round(total / 1048576), installed: modelInstalled(cfg, d.key), sizeMB,
    };
  });
}
function sendModelEvent(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('model:event', payload);
}

// 写 .part，校验后发布；已存在的最终文件由用户管理，绝不覆盖。
async function downloadFileWithResume(ctrl, url, dest, expected, onBytes) {
  const part = dest + '.part';
  const weightSize = path.basename(dest) === 'model.bin' ? expected : 0;
  let controller;
  let timer;
  let timedOut = false;
  const progress = (bytes) => { if (onBytes) onBytes(bytes); };
  const existingFileError = () => new Error('目标文件已存在但不完整或不可用，请先移动该文件再重试：' + dest);
  const publish = async () => {
    if (ctrl.cancelled) throw new Error('已取消');
    if (!modelFileUsable(part, weightSize)) throw new Error('文件内容无效，已保留断点：' + part);
    try {
      // link 是不覆盖的原子发布；不支持硬链接的文件系统使用排他复制。
      try { await fs.promises.link(part, dest); }
      catch (e) {
        if (!['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EPERM'].includes(e.code)) throw e;
        await fs.promises.copyFile(part, dest, fs.constants.COPYFILE_EXCL);
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (!modelFileUsable(dest, weightSize)) throw existingFileError();
    }
    await fs.promises.unlink(part);
  };
  try {
    if (ctrl.cancelled) throw new Error('已取消');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (modelFileUsable(dest, weightSize)) { progress(expected); return; }
    if (fs.existsSync(dest)) throw existingFileError();
    let start = 0;
    try {
      const stat = fs.statSync(part);
      if (!stat.isFile()) throw new Error('断点路径不是文件：' + part);
      start = stat.size;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (start > expected) throw new Error('断点文件超过预期大小，请先移动该文件再重试：' + part);
    if (start === expected) { await publish(); progress(expected); return; }

    controller = new AbortController();
    ctrl.abortController = controller;
    const keepAlive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
    };
    keepAlive();
    const headers = start ? { Range: 'bytes=' + start + '-' } : {};
    // Electron IncomingMessage 没有 pause/resume；fetch 的 Web Stream 可由 pipeline 施加背压。
    const res = await net.fetch(url, { method: 'GET', headers, signal: controller.signal });
    if (res.status !== 200 && res.status !== 206) throw new Error('HTTP ' + res.status);
    let append = false;
    if (res.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') || '');
      if (!range || Number(range[1]) !== start || Number(range[2]) !== expected - 1 || Number(range[3]) !== expected) {
        throw new Error('服务器 Content-Range 不符，已保留原断点');
      }
      append = start > 0;
    }
    // 服务器忽略 Range 并返回 200 时，从头写 part，不能追加重复字节。
    let got = append ? start : 0;
    const length = res.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== expected - got)) {
      throw new Error('服务器 Content-Length 与预期文件大小不符，已保留原断点');
    }
    if (!res.body) throw new Error('服务器返回空响应');
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        if (got + chunk.length > expected) return callback(new Error('下载内容超过预期文件大小'));
        got += chunk.length;
        keepAlive();
        progress(got);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(part, { flags: append ? 'a' : 'w' }), { signal: controller.signal });
    if (ctrl.cancelled) throw new Error('已取消');
    const size = fs.statSync(part).size;
    if (size !== expected) throw new Error('文件大小不符（' + size + '/' + expected + '），已保留断点可重试');
    await publish();
  } catch (e) {
    if (ctrl.cancelled) throw new Error('已取消，已保留断点可重试');
    if (timedOut) throw new Error('下载超时，已保留断点，请检查网络后重试');
    if (['EACCES', 'EPERM', 'EROFS'].includes(e.code)) {
      throw new Error('模型目录没有读写权限：' + path.dirname(dest) + '。请检查目录权限，或将应用安装到可写目录后重试。');
    }
    if (e.code === 'ENOSPC') throw new Error('磁盘空间不足，已保留断点，请腾出空间后重试');
    throw new Error('下载 ' + path.basename(dest) + ' 失败：' + ((e && e.message) || String(e)));
  } finally {
    clearTimeout(timer);
    if (controller) controller.abort();
    if (ctrl.abortController === controller) ctrl.abortController = null;
  }
}

async function downloadModel(cfg, key) {
  const def = MODEL_CATALOG.find((d) => d.key === key);
  if (!def) { sendModelEvent({ type: 'error', key, message: '未知模型：' + key }); return; }
  if (modelDownloads.has(key)) { sendModelEvent({ type: 'error', key, message: '该模型正在下载中' }); return; }

  const ctrl = { cancelled: false, abortController: null };
  modelDownloads.set(key, ctrl);
  const total = modelTotalBytes(def);
  let doneBytes = 0;
  sendModelEvent({ type: 'start', key, received: 0, total, pct: 0 });
  try {
    if (modelInstalled(cfg, key)) { sendModelEvent({ type: 'done', key }); return; }
    for (const f of def.files) {
      if (ctrl.cancelled) throw new Error('已取消');
      const url = MODELSCOPE_BASE + '/' + def.repo + '/resolve/master/' + encodeURIComponent(f.path);
      const dest = path.join(modelDir(cfg, key), f.path);
      const base = doneBytes;
      await downloadFileWithResume(ctrl, url, dest, f.size, (got) => {
        const received = base + got;
        const pct = total ? Math.min(100, Math.round((received / total) * 1000) / 10) : 0;
        sendModelEvent({ type: 'progress', key, file: f.path, received, total, pct });
      });
      doneBytes += f.size;
    }
    if (ctrl.cancelled) throw new Error('已取消');
    if (!modelInstalled(cfg, key)) throw new Error('模型文件不完整或无效，请检查必要文件后重试');
    sendModelEvent({ type: 'done', key });
  } catch (e) {
    sendModelEvent({ type: 'error', key, message: (e && e.message) || String(e) });
  } finally {
    modelDownloads.delete(key);
  }
}

function runEngineOnce(cfg, subArgs, timeoutMs) {
  return new Promise((resolve) => {
    const inv = engineInvocation(cfg, subArgs);
    let out = '';
    let settled = false;
    let child;
    try {
      child = spawn(inv.cmd, inv.args, { cwd: inv.cwd, windowsHide: true, env: buildEnv(cfg) });
    } catch (e) {
      return resolve(null);
    }
    const finish = (val) => { if (settled) return; settled = true; try { clearTimeout(timer); } catch (e) { /* ignore */ } resolve(val); };
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } finish(null); }, timeoutMs || 20000);
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => finish(null));
    child.on('close', () => {
      for (const line of out.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try { return finish(JSON.parse(s)); } catch (e) { /* next */ }
      }
      finish(null);
    });
  });
}

async function probeGpu(cfg) {
  if (gpuCache !== null) return gpuCache;
  const o = await runEngineOnce(cfg, ['probe'], 20000);
  gpuCache = !!(o && o.cuda) && !!(cfg.cudaDir && fs.existsSync(cfg.cudaDir));
  return gpuCache;
}

function probeDuration(ffprobe, filePath) {
  return new Promise((resolve) => {
    execFile(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath],
      { windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        if (err) return resolve(0);
        const v = parseFloat(String(stdout).trim());
        resolve(Number.isFinite(v) ? v : 0);
      });
  });
}

function sendEvent(id, ev) {
  if (win && !win.isDestroyed()) win.webContents.send('transcribe:event', { id, ev });
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 1024, minHeight: 640,
    frame: false, backgroundColor: '#ffffff', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
    for (const c of children.values()) { try { c.kill(); } catch (e) { /* ignore */ } }
    children.clear();
  });
}

/* ---------------- IPC ---------------- */
function registerIpc() {
  ipcMain.handle('config:get', () => {
    const cfg = loadConfig();
    return {
      packaged: cfg.packaged,
      useEngineExe: cfg.useEngineExe,
      modelRoot: modelRoot(cfg),
      warnings: cfg.warnings,
    };
  });

  ipcMain.handle('settings:get', async () => {
    const cfg = loadConfig();
    const gpu = await probeGpu(cfg);
    return { settings: getSettings(), models: listModels(cfg), gpu, packaged: cfg.packaged };
  });

  ipcMain.handle('settings:set', (_e, patch) => {
    const before = getSettings();
    const s = saveSettings(patch);
    try {
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'historyDir') && (patch.historyDir || '') !== (before.historyDir || '')) {
        const oldF = before.historyDir ? path.join(before.historyDir, 'history.json') : dataFile('history.json');
        const newF = s.historyDir ? path.join(s.historyDir, 'history.json') : dataFile('history.json');
        if (oldF !== newF && fs.existsSync(oldF) && !fs.existsSync(newF)) {
          fs.mkdirSync(path.dirname(newF), { recursive: true });
          fs.copyFileSync(oldF, newF);
        }
      }
    } catch (e) { /* ignore */ }
    return s;
  });

  ipcMain.handle('models:list', () => listModels(loadConfig()));

  ipcMain.handle('models:catalog', () => getCatalog(loadConfig()));
  ipcMain.handle('model:download', (_e, key) => {
    const cfg = loadConfig();
    if (!modelDownloads.has(key)) downloadModel(cfg, key);
    return { ok: true };
  });
  ipcMain.handle('model:cancel', (_e, key) => {
    const ctrl = modelDownloads.get(key);
    if (ctrl) {
      ctrl.cancelled = true;
      if (ctrl.abortController) ctrl.abortController.abort();
    }
    return { ok: true };
  });
  ipcMain.handle('models:openDir', async () => {
    const cfg = loadConfig();
    const root = modelRoot(cfg);
    try { fs.mkdirSync(root, { recursive: true }); } catch (e) { /* ignore */ }
    try { shell.openPath(root); } catch (e) { /* ignore */ }
    return root;
  });

  ipcMain.handle('terms:get', () => getTerms());
  ipcMain.handle('terms:save', (_e, t) => { saveTerms(t); return getTerms(); });

  ipcMain.handle('history:list', () => getHistory());
  ipcMain.handle('history:clear', () => { writeJson(historyFile(), []); return []; });
  ipcMain.handle('history:path', () => historyFile());
  ipcMain.handle('history:reveal', () => {
    const f = historyFile();
    try {
      if (fs.existsSync(f)) shell.showItemInFolder(f);
      else shell.openPath(path.dirname(f));
    } catch (e) { /* ignore */ }
    return f;
  });

  ipcMain.handle('dialog:pickDir', async () => {
    const res = await dialog.showOpenDialog(win, { title: '选择输出目录', properties: ['openDirectory', 'createDirectory'] });
    return res.canceled || !res.filePaths.length ? '' : res.filePaths[0];
  });

  ipcMain.handle('files:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择音视频文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音视频', extensions: MEDIA_EXT }],
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('file:probe', async (_e, filePath) => {
    const cfg = loadConfig();
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch (e) { size = 0; }
    const duration = await probeDuration(cfg.ffprobe, filePath);
    return { size, duration };
  });

  ipcMain.handle('transcribe:start', async (_e, payload) => {
    const cfg = loadConfig();
    const settings = getSettings();
    const { id, filePath } = payload || {};

    if (!cfg.useEngineExe && (!cfg.python || !fs.existsSync(cfg.python))) {
      return { ok: false, error: '未找到 Python 运行时或 engine.exe，请检查安装。' };
    }
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, error: '输入文件不存在：' + filePath };
    }

    const gpu = await probeGpu(cfg);
    const modelSel = resolveModel(cfg, settings.modelKey, gpu);
    if (!modelSel.dir) return { ok: false, error: '还没有可用模型，请到「设置 → 模型」下载，或导入离线模型包。' };

    const device = settings.device === 'gpu' ? 'cuda' : (settings.device === 'cpu' ? 'cpu' : 'auto');
    let outDir = (payload && payload.outDir) || settings.outDir || cfg.outDir;
    if (!outDir) outDir = path.join(path.dirname(filePath), '文字稿');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { return { ok: false, error: '无法创建输出目录：' + e.message }; }

    const tArgs = [
      'transcribe',
      '--input', filePath,
      '--out', outDir,
      '--lang', settings.lang || cfg.lang || 'zh',
      '--device', device,
      '--model', modelSel.dir,
      '--formats', settings.formats || cfg.formats || 'txt,srt',
      '--progress-json',
      '--prompt', cfg.prompt || '以下是普通话对话。',
      '--beam', String(cfg.beam || 5),
    ];
    if (settings.termsEnabled) {
      const tf = dataFile('terms.json');
      const tt = getTerms();
      if (fs.existsSync(tf) && (tt.terms.length || Object.keys(tt.replace).length)) tArgs.push('--terms', tf);
    }

    const inv = engineInvocation(cfg, tArgs);
    let child;
    try {
      child = spawn(inv.cmd, inv.args, { cwd: inv.cwd, windowsHide: true, env: buildEnv(cfg) });
    } catch (e) {
      return { ok: false, error: '启动引擎失败：' + e.message };
    }
    children.set(id, child);

    let buf = '';
    let stderr = '';
    let terminal = false;

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (e) { continue; }
        if (ev.type === 'done' || ev.type === 'error') terminal = true;
        if (ev.type === 'done') {
          addHistory({
            id, name: path.basename(filePath), filePath,
            outputs: ev.outputs || {}, elapsed: ev.elapsed_sec, speed: ev.speed_x,
            chars: ev.chars, model: modelSel.key, device,
            outDir, time: Date.now(),
          });
          ev.model = modelSel.key;
          ev.device = device;
        }
        sendEvent(id, ev);
      }
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      children.delete(id);
      if (!terminal) { terminal = true; sendEvent(id, { type: 'error', message: '启动引擎失败：' + err.message }); }
    });
    child.on('close', (code) => {
      children.delete(id);
      if (!terminal && code !== 0) sendEvent(id, { type: 'error', message: (stderr.trim() || ('引擎退出码 ' + code)).slice(-800) });
      else if (!terminal) sendEvent(id, { type: 'error', message: '引擎未返回结果（退出码 ' + code + '）' });
    });

    return { ok: true, outDir, model: modelSel.key, device };
  });

  ipcMain.on('transcribe:cancel', (_e, id) => {
    const c = children.get(id);
    if (!c) return;
    try { c.kill(); } catch (e) { /* ignore */ }
    children.delete(id);
  });

  ipcMain.handle('preview:read', async (_e, p) => {
    try { return fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, ''); } catch (e) { return ''; }
  });

  ipcMain.on('clipboard:write', (_e, text) => { try { clipboard.writeText(String(text == null ? '' : text)); } catch (e) { /* ignore */ } });
  ipcMain.on('shell:showInFolder', (_e, p) => {
    try {
      if (p && fs.existsSync(p)) shell.showItemInFolder(p);
      else if (p) shell.openPath(path.dirname(p));
    } catch (e) { /* ignore */ }
  });

  ipcMain.on('win:minimize', () => win && win.minimize());
  ipcMain.on('win:toggleMaximize', () => { if (!win) return; if (win.isMaximized()) win.unmaximize(); else win.maximize(); });
  ipcMain.on('win:close', () => win && win.close());
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
