'use strict';
/**
 * 运行配置解析。
 * 优先级：环境变量 > app/config.local.json（本机，gitignore） > 内置默认。
 * 两种运行形态自动切换：
 *   - 开发态（未打包）：用 python 解释器跑 `-m engine.cli`
 *   - 打包态（app.isPackaged）：用 resources/engine/engine.exe，模型/ffmpeg 走 resourcesPath
 * 仓库只提交 config.local.example.json，绝不提交含本机绝对路径的 config.local.json。
 */
const path = require('path');
const fs = require('fs');

let electronApp = null;
try {
  electronApp = require('electron').app || null;
} catch (e) {
  electronApp = null;
}

function deriveModelName(modelPath) {
  if (!modelPath) return '(未配置)';
  const m = /faster-whisper-([^\\/]+)/i.exec(modelPath);
  if (m) return m[1];
  try {
    const base = path.basename(modelPath.replace(/[\\/]+$/, ''));
    return base || '(未配置)';
  } catch (e) {
    return '(未配置)';
  }
}

function userDataDir() {
  try {
    if (electronApp && typeof electronApp.getPath === 'function') return electronApp.getPath('userData');
  } catch (e) { /* ignore */ }
  return '';
}

function readLocal(appDir) {
  const candidates = [path.join(appDir, 'config.local.json')];
  try {
    if (electronApp && electronApp.isPackaged) {
      candidates.push(path.join(path.dirname(electronApp.getPath('exe')), 'config.local.json'));
    }
  } catch (e) { /* ignore */ }
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      } catch (e) {
        console.error('[config] 读取失败：', p, e.message);
      }
    }
  }
  return {};
}

function loadConfig() {
  const appDir = __dirname;
  const projectRoot = path.join(appDir, '..');
  const packaged = !!(electronApp && electronApp.isPackaged);
  const resRoot = process.resourcesPath || projectRoot;

  const base = packaged
    ? {
        engineRoot: resRoot,
        engineExe: path.join(resRoot, 'engine', 'engine.exe'),
        python: '',
        model: '',
        modelName: '',
        device: 'auto',
        formats: 'txt,srt',
        lang: 'zh',
        prompt: '以下是普通话对话。',
        beam: 5,
        outDir: '',
        cudaDir: '',
        extraPath: '',
        ffmpeg: path.join(resRoot, 'bin', 'ffmpeg.exe'),
        ffprobe: '',
      }
    : {
        engineRoot: projectRoot,
        engineExe: '',
        python: '',
        model: '',
        modelName: '',
        device: 'auto',
        formats: 'txt,srt',
        lang: 'zh',
        prompt: '以下是普通话对话。',
        beam: 5,
        outDir: '',
        cudaDir: '',
        extraPath: '',
        ffmpeg: 'ffmpeg',
        ffprobe: '',
      };

  const local = readLocal(appDir);
  const pick = (key, env) => {
    if (env && process.env[env] !== undefined && process.env[env] !== '') return process.env[env];
    if (local[key] !== undefined && local[key] !== null && local[key] !== '') return local[key];
    return base[key];
  };

  const cfg = {
    packaged,
    engineRoot: pick('engineRoot', 'ATD_ROOT') || base.engineRoot,
    engineExe: pick('engineExe', 'ATD_ENGINE_EXE') || '',
    python: pick('python', 'ATD_PYTHON') || '',
    model: pick('model', 'ATD_MODEL') || '',
    device: pick('device', 'ATD_DEVICE') || 'auto',
    formats: pick('formats', 'ATD_FORMATS') || 'txt,srt',
    lang: pick('lang', 'ATD_LANG') || 'zh',
    prompt: pick('prompt', 'ATD_PROMPT') || '以下是普通话对话。',
    beam: Number(pick('beam', 'ATD_BEAM') || 5),
    outDir: pick('outDir', 'ATD_OUT') || '',
    cudaDir: pick('cudaDir', 'ATD_CUDA_DIR') || '',
    extraPath: pick('extraPath', 'ATD_EXTRA_PATH') || '',
    ffmpeg: pick('ffmpeg', 'FFMPEG') || '',
    ffprobe: pick('ffprobe', 'FFPROBE') || '',
  };

  // CUDA 运行库解析顺序（B 档：默认不含 cuda，GPU 包按需装到 userData/gpu/cuda）：
  //   1) 环境变量 / config.local.json 显式指定（开发态常见：torch/lib）
  //   2) userData/gpu/cuda（按需下载/导入的 GPU 加速包）
  //   3) resourcesPath/cuda（兼容 v0.4 及更早的内置全量版）
  const gds = userDataDir();
  const gpuPackDir = gds ? path.join(gds, 'gpu', 'cuda') : '';
  const cudaCandidates = [cfg.cudaDir, gpuPackDir, packaged ? path.join(resRoot, 'cuda') : ''].filter(Boolean);
  cfg.gpuPackDir = gpuPackDir;
  cfg.cudaDir = cudaCandidates.find((p) => fs.existsSync(p)) || (cfg.cudaDir || '');

  cfg.useEngineExe = !!(cfg.engineExe && fs.existsSync(cfg.engineExe));
  cfg.modelName = local.modelName || deriveModelName(cfg.model);

  cfg.warnings = [];
  if (cfg.useEngineExe) {
    // exe 模式不需要 python
  } else if (!cfg.python || !fs.existsSync(cfg.python)) {
    cfg.warnings.push('未找到 Python 运行时或 engine.exe，请在 app/config.local.json 配置 python，或使用打包版。');
  }
  // 打包态不再内置模型：model 为空属正常（由应用内下载/导入模型包提供）。
  if (cfg.model && !fs.existsSync(cfg.model)) {
    cfg.warnings.push('未找到模型目录，请在 app/config.local.json 配置 model。');
  }
  return cfg;
}

module.exports = loadConfig;
