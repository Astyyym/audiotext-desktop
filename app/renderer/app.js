'use strict';
/* AudioText Desktop · 渲染层（转写 / 历史 / 术语库 / 设置） */

const $ = (s) => document.querySelector(s);
const listEl = $('#list');
const countEl = $('#count');
const toastEl = $('#toast');

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|flv|wmv|3gp|ts|m2ts|rmvb|mpeg|mpg|asf|dv)$/i;
const DEVICE_LABEL = { auto: '自动', gpu: 'GPU', cpu: 'CPU' };
const DEFAULT_AI_PROMPT = '你是一名面试复盘助手。下面这段文字是一场面试（或电话沟通）的语音转写稿，可能存在同音错别字，请结合上下文自动纠正。请只依据原文、不要编造，完成：\n1) 按流程列出面试官问过的【问题清单】（合并重复、改成规范问句）；\n2) 针对每个问题给出【回答要点】，原文没答或含糊的标注「未明确回答」；\n3) 单独整理【关键信息】：公司/项目/岗位、技术栈、薪资范围、到岗时间、工作地点、加班与出差等；\n4) 给出【复盘建议】：亮点与可改进处。\n请用中文分点输出，条理清晰。';

let CONFIG = null;
let SETTINGS = { device: 'auto', modelKey: 'auto', outDir: '', lang: 'zh', formats: 'txt,srt', termsEnabled: false, historyDir: '', aiPrompt: DEFAULT_AI_PROMPT };
let MODELS = [];
let GPU = null;
let CATALOG = [];        // 可下载模型清单（含是否已安装）
let modelDl = {};        // key -> { status: 'downloading'|'error', pct, message }
let GPUPACK = null;      // GPU 加速包状态：{ installed, nvidia, available, downloading, pct, downloadMB, sizeMB }

let staged = [];       // 待确认文件（在虚线框内）
let stagedSeq = 0;
let tasks = [];        // 任务队列
let seq = 0;
let running = false;
let terms = { terms: [], replace: {} };

/* ---------------- 工具 ---------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function basename(p) { return String(p).split(/[\\/]/).pop(); }
function fmtDur(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(s).padStart(2, '0');
}
function fmtSize(bytes) {
  if (!bytes) return '—';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
}
function fmtLeft(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  sec = Math.round(sec);
  return sec >= 60 ? Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒' : sec + ' 秒';
}
function fmtTime(ms) {
  const d = new Date(ms || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function extLabel(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toUpperCase().slice(0, 4) : 'FILE';
}
function friendlyError(msg) {
  const raw = String(msg || '');
  if (/还没有可用模型|未找到可用模型/.test(raw)) return raw;
  if (/ffmpeg|CalledProcessError|returned non-zero|exit status/i.test(raw)) return '音频解码失败，请检查文件是否完整或换一种格式';
  if (/模型|model/i.test(raw)) return '模型加载失败，请检查设置里的模型';
  if (/ffprobe|not found|找不到/i.test(raw)) return '找不到音视频处理组件（ffmpeg）';
  if (/Traceback|Error:/i.test(raw)) return '转写出错，可重试';
  return raw.length > 80 ? raw.slice(0, 80) + '…' : (raw || '转写失败，可重试');
}
function deviceLabel() { return DEVICE_LABEL[SETTINGS.device] || '自动'; }
function modelLabel() { return SETTINGS.modelKey === 'auto' ? '自动' : (SETTINGS.modelKey || '自动'); }

/* ---------------- 视图切换 ---------------- */
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
  document.querySelectorAll('.sidebar .nav a[data-view]').forEach((a) => {
    a.classList.toggle('active', a.dataset.view === name);
  });
  if (name === 'history') renderHistory();
  if (name === 'terms') loadTerms().then(renderTerms);
  if (name === 'settings') renderSettings();
}

/* ---------------- 初始化 ---------------- */
async function init() {
  CONFIG = await window.api.getConfig();
  await refreshSettings();
  wireUi();
  window.api.onEvent(onEngineEvent);
  window.api.onModelEvent(onModelEvent);
  window.api.onGpuPackEvent(onGpuPackEvent);
  renderStaged();
  render();
  if ((CONFIG.warnings || []).length) setTimeout(() => toast(CONFIG.warnings[0]), 400);
  else if (!MODELS.length) setTimeout(() => toast('还没有可用模型，请到「设置 → 模型」下载，或导入离线模型包'), 500);
}

async function refreshCatalog() {
  try { CATALOG = await window.api.getModelCatalog(); } catch (e) { CATALOG = []; }
}

/* ---------------- GPU 加速包（可选） ---------------- */
async function refreshGpuPack() {
  try { GPUPACK = await window.api.getGpuPack(); } catch (e) { GPUPACK = null; }
}
function renderGpuPack() {
  const desc = document.querySelector('#gpuPackDesc');
  const actions = document.querySelector('#gpuPackActions');
  const prog = document.querySelector('#gpuPackProg');
  const bar = document.querySelector('#gpuPackBar');
  if (!desc || !actions) return;
  const g = GPUPACK || {};
  let text;
  if (g.installed) text = '已启用' + (g.sizeMB ? '（约 ' + g.sizeMB + ' MB）' : '') + '，可用 GPU 加速';
  else if (g.downloading) text = '下载中 ' + (g.pct || 0).toFixed(1) + '%' + (g.downloadMB ? ' / 约 ' + g.downloadMB + ' MB' : '');
  else if (g.nvidia) text = '检测到 NVIDIA 显卡，可下载 GPU 加速包提速' + (g.downloadMB ? '（约 ' + g.downloadMB + ' MB）' : '');
  else text = '未检测到 NVIDIA 显卡，保持 CPU 即可';
  desc.textContent = text;
  if (g.downloading) actions.innerHTML = '<button class="btn btn-ghost btn-sm" id="gpuPackCancel">取消</button>';
  else if (g.installed) actions.innerHTML = '<span class="mi-status ok">已启用</span>';
  else actions.innerHTML = '<button class="btn btn-primary btn-sm" id="gpuPackDownload"' + (g.available ? '' : ' disabled') + '>' + (g.available ? '下载' : '尚未发布') + '</button>';
  if (prog) prog.hidden = !g.downloading;
  if (bar) bar.style.width = Math.max(1, Math.min(100, g.pct || 0)) + '%';
}
function onGpuPackEvent(ev) {
  if (!ev) return;
  if (!GPUPACK) GPUPACK = {};
  if (ev.type === 'start' || ev.type === 'progress') {
    GPUPACK.downloading = true;
    if (typeof ev.pct === 'number') GPUPACK.pct = ev.pct;
    if (ev.total) GPUPACK.downloadMB = Math.round(ev.total / 1048576);
  } else if (ev.type === 'done') {
    GPUPACK.downloading = false; GPUPACK.pct = 100;
    toast('GPU 加速包安装完成');
    refreshGpuPack().then(() => { renderGpuPack(); refreshSettings().then(() => { if (!$('#view-settings').hidden) renderSettings(); }); });
    return;
  } else if (ev.type === 'removed') {
    toast('已移除 GPU 加速包');
    refreshGpuPack().then(renderGpuPack);
    return;
  } else if (ev.type === 'error') {
    if (/已取消/.test(ev.message || '')) { GPUPACK.downloading = false; GPUPACK.pct = 0; }
    else { GPUPACK.downloading = false; toast('GPU 加速包：' + (ev.message || '操作失败')); }
  }
  renderGpuPack();
}

async function refreshSettings() {
  const r = await window.api.getSettings();
  SETTINGS = Object.assign({ aiPrompt: DEFAULT_AI_PROMPT }, r.settings || {});
  MODELS = r.models || [];
  GPU = r.gpu;
  await refreshCatalog();
  await refreshGpuPack();
  fillHeaderSelects();
  updateHeadAndEnv();
}

function updateHeadAndEnv() {
  $('#envDevice').textContent = deviceLabel();
  $('#envModel').textContent = modelLabel();
  const fmts = (SETTINGS.formats || 'txt,srt').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  $('#envOut').textContent = fmts.join(' · ') || '—';
  $('#envDot').classList.toggle('warn', GPU === false && SETTINGS.device !== 'cpu');
}

function fillHeaderSelects() {
  const ds = $('#hdrDevice');
  if (ds) {
    ds.innerHTML = [['auto', '自动'], ['gpu', 'GPU'], ['cpu', 'CPU']]
      .map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    ds.value = SETTINGS.device || 'auto';
  }
  const ms = $('#hdrModel');
  if (ms) {
    let opts = '<option value="auto">自动</option>';
    MODELS.forEach((m) => { opts += `<option value="${esc(m.key)}">${esc(m.key)}</option>`; });
    if (SETTINGS.modelKey && SETTINGS.modelKey !== 'auto' && !MODELS.some((m) => m.key === SETTINGS.modelKey)) {
      opts += `<option value="${esc(SETTINGS.modelKey)}">${esc(SETTINGS.modelKey)}</option>`;
    }
    ms.innerHTML = opts;
    ms.value = SETTINGS.modelKey || 'auto';
  }
}

/* ---------------- 待确认区（staging） ---------------- */
function isDup(path) {
  if (staged.some((s) => s.path === path)) return true;
  return tasks.some((t) => t.path === path && (t.status === 'queued' || t.status === 'running'));
}

async function addPaths(paths) {
  if (!paths || !paths.length) return 0;
  let added = 0, dup = 0;
  for (const p of paths) {
    if (!p) continue;
    if (isDup(p)) { dup++; continue; }
    const name = basename(p);
    const kind = VIDEO_EXT.test(name) ? 'video' : 'audio';
    let probe = { size: 0, duration: 0 };
    try { probe = await window.api.probe(p); } catch (e) { /* ignore */ }
    staged.push({ sid: ++stagedSeq, path: p, name, kind, size: probe.size || 0, dur: probe.duration || 0 });
    added++;
  }
  renderStaged();
  if (added) toast('已加入待确认区，点「开始全部」开始转写');
  else if (dup) toast('这些文件已在待确认区或队列中');
  return added;
}

function renderStaged() {
  const has = staged.length > 0;
  const prompt = $('#dzPrompt'), wrap = $('#stagedWrap');
  if (prompt) prompt.hidden = has;
  if (wrap) wrap.hidden = !has;
  const dz = $('#dropzone');
  if (dz) dz.classList.toggle('has-staged', has);
  const c = $('#stagedCount'); if (c) c.textContent = staged.length;
  const sl = $('#stagedList');
  if (sl) {
    sl.innerHTML = has ? staged.map((s) => `
      <div class="stage-card" data-sid="${s.sid}">
        <button class="sc-del" data-sdel="${s.sid}" title="移除">×</button>
        <div class="sc-fmt ${s.kind}">${extLabel(s.name)}</div>
        <div class="sc-name" title="${esc(s.name)}">${esc(s.name)}</div>
      </div>`).join('') : '';
  }
}

/* ---------------- 转写 ---------------- */
function startAll() {
  let moved = 0;
  if (staged.length) {
    staged.forEach((s) => {
      tasks.push({ id: ++seq, path: s.path, name: s.name, kind: s.kind, size: s.size, dur: s.dur, status: 'queued', progress: 0, previewText: null, outputs: null, error: '', expanded: false });
      moved++;
    });
    staged = [];
    renderStaged();
    render();
  }
  const pending = tasks.filter((t) => t.status === 'queued' || t.status === 'failed');
  if (!pending.length) {
    toast(moved ? '已加入队列' : '没有待开始的任务');
    return;
  }
  pending.forEach((t) => {
    if (t.status === 'failed') { t.status = 'queued'; t.progress = 0; t.error = ''; t.previewText = null; t.outputs = null; }
  });
  render();
  startNext();
}

async function startNext() {
  if (running) return;
  const t = tasks.find((x) => x.status === 'queued');
  if (!t) return;
  running = true;
  t.status = 'running'; t.progress = 0; t.error = ''; t.previewText = null; t._t0 = Date.now(); t.model = ''; t.device = '';
  render();
  let res;
  try {
    res = await window.api.startTask({ id: t.id, filePath: t.path, outDir: SETTINGS.outDir || '' });
  } catch (e) {
    res = { ok: false, error: e.message || String(e) };
  }
  if (!res || !res.ok) {
    t.status = 'failed'; t.error = (res && res.error) || '启动失败'; running = false; render(); startNext();
  } else {
    if (res.model) t.model = res.model;
    if (res.device) t.device = res.device;
  }
}

function onEngineEvent({ id, ev }) {
  const t = tasks.find((x) => x.id === id);
  if (!t || !ev) return;
  if (ev.type === 'status') {
    if (ev.stage === 'transcribing') { if (ev.duration) t.dur = ev.duration; t._t0 = Date.now(); }
    return;
  }
  if (ev.type === 'segment') {
    if (typeof ev.progress === 'number') t.progress = ev.progress;
    (t._segs = t._segs || []).push(ev);
    render();
    return;
  }
  if (ev.type === 'done') {
    t.status = 'done'; t.progress = 100;
    t.outputs = ev.outputs || {}; t.chars = ev.chars; t.elapsed = ev.elapsed_sec; t.speed = ev.speed_x;
    if (ev.model) t.model = ev.model;
    if (ev.device) t.device = ev.device;
    t.previewText = null; running = false; render();
    toast('转写完成：' + t.name);
    startNext();
    return;
  }
  if (ev.type === 'error') {
    t.status = 'failed'; t.error = ev.message || '转写失败'; running = false; render(); startNext();
  }
}

function speedLeft(t) {
  if (!t._t0 || !t.dur) return { speed: null, left: null };
  const elapsed = (Date.now() - t._t0) / 1000;
  const processed = (t.dur * (t.progress || 0)) / 100;
  const speed = elapsed > 0.2 ? processed / elapsed : 0;
  const left = speed > 0.01 ? (t.dur - processed) / speed : NaN;
  return { speed, left };
}

function statusBlock(t) {
  if (t.status === 'running') {
    const { speed, left } = speedLeft(t);
    const sp = speed ? speed.toFixed(1) + '×' : '—';
    return `<div class="status"><span class="pill run"><span class="d"></span>转写中</span>
      <div class="prog"><i style="width:${Math.max(0, Math.min(100, t.progress || 0))}%"></i></div>
      <div class="prog-txt"><span>${(t.progress || 0).toFixed(0)}% · ${sp} 实时</span><span>剩余 ${fmtLeft(left)}</span></div></div>`;
  }
  if (t.status === 'done') {
    const meta = `用时 ${t.elapsed != null ? t.elapsed + ' 秒' : '—'}${t.speed ? ' · ' + t.speed + '× 实时' : ''}${t.model ? ' · ' + t.model : ''} · 已生成 ${outputsLabel(t)}`;
    return `<div class="status"><span class="pill ok"><span class="d"></span>已完成</span><div class="st-meta">${esc(meta)}</div></div>`;
  }
  if (t.status === 'failed') {
    return `<div class="status"><span class="pill err"><span class="d"></span>失败</span><div class="st-meta" title="${esc(t.error)}">${esc(friendlyError(t.error))}</div></div>`;
  }
  return `<div class="status"><span class="pill wait"><span class="d"></span>排队中</span><div class="st-meta">等待开始</div></div>`;
}
function outputsLabel(t) {
  if (!t.outputs) return '—';
  const keys = Object.keys(t.outputs).filter((k) => t.outputs[k]);
  return keys.length ? keys.map((k) => k.toUpperCase()).join(' / ') : '—';
}
function actionsBlock(t) {
  if (t.status === 'done') {
    return `<div class="actions">
      <button class="act-txt" data-act="copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>复制全文</button>
      <button class="act-txt" data-act="preview"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/></svg>${t.expanded ? '收起预览' : '展开预览'}</button>
      <button class="icon-btn" data-act="copyprompt" title="复制 AI 总结提示词"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 3 2.2 5.6L20 11l-5.8 2.4L12 19l-2.2-5.6L4 11l5.8-2.4Z"/></svg></button>
      <button class="icon-btn" data-act="open" title="打开所在文件夹"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg></button>
      <button class="icon-btn" data-act="remove" title="移除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`;
  }
  if (t.status === 'failed') {
    return `<div class="actions"><button class="act-txt" data-act="retry">重试</button><button class="icon-btn" data-act="remove" title="移除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`;
  }
  return `<div class="actions"><button class="icon-btn" data-act="remove" title="移除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`;
}
function previewBlock(t) {
  const chars = t.chars != null ? t.chars : (t.previewText ? t.previewText.replace(/\s/g, '').length : '—');
  const body = t.previewText != null ? esc(t.previewText) : '（加载中…）';
  return `<div class="preview"><div class="pv-top"><span class="pv-label">转写结果预览</span><span class="pv-t">${fmtDur(t.dur)} · 约 ${chars} 字 · 已生成 ${esc(outputsLabel(t))}</span></div><div class="pv-body">${body}</div></div>`;
}
function render() {
  countEl.textContent = tasks.length;
  if (!tasks.length) { listEl.innerHTML = '<div class="empty">还没有任务，把音视频拖到上方虚线框，再点「开始全部」。</div>'; return; }
  listEl.innerHTML = tasks.map((t) => `
    <div class="task" data-id="${t.id}">
      <div class="ftype ${t.kind}">${extLabel(t.name)}</div>
      <div class="finfo"><div class="fname" title="${esc(t.name)}">${esc(t.name)}</div>
        <div class="fmeta"><span>${t.kind === 'video' ? '视频' : '音频'}</span><span class="sep">·</span><span>${t.dur ? fmtDur(t.dur) : '—'}</span><span class="sep">·</span><span>${fmtSize(t.size)}</span></div></div>
      <div class="rightzone">${statusBlock(t)}${actionsBlock(t)}</div>
      ${t.status === 'done' && t.expanded ? previewBlock(t) : ''}
    </div>`).join('');
}

async function readPreview(t) {
  if (t.previewText != null) return;
  const p = t.outputs && t.outputs.txt;
  if (!p) return;
  try { t.previewText = await window.api.readText(p); } catch (e) { t.previewText = ''; }
}

/* ---------------- 历史 ---------------- */
async function renderHistory() {
  try {
    const p = await window.api.getHistoryPath();
    const line = $('#historyPathLine');
    if (line) line.textContent = '存储位置：' + p;
  } catch (e) { /* ignore */ }
  const list = await window.api.listHistory();
  const el = $('#historyList');
  if (!list.length) { el.innerHTML = '<div class="empty">暂无历史记录。</div>'; return; }
  el.innerHTML = list.map((h, i) => `
    <div class="hist" data-i="${i}">
      <div class="h-top"><span class="pill ok" style="padding:2px 8px;font-size:11px;"><span class="d"></span>${esc(h.model || 'done')}</span>
        <span class="h-name" title="${esc(h.filePath)}">${esc(h.name)}</span>
        <span class="h-meta">${fmtTime(h.time)}</span></div>
      <div class="h-sub"><span>${h.device === 'cuda' ? 'GPU' : (h.device || 'CPU')}</span><span>用时 ${h.elapsed != null ? h.elapsed + ' 秒' : '—'}</span>${h.speed ? '<span>' + h.speed + '× 实时</span>' : ''}<span>${h.chars != null ? h.chars + ' 字' : ''}</span></div>
      <div class="h-acts">
        <button class="act-txt" data-hact="open">打开输出</button>
        <button class="act-txt" data-hact="copy">复制全文</button>
        <button class="act-txt" data-hact="rerun">重新转写</button>
      </div>
    </div>`).join('');
}

/* ---------------- 术语 ---------------- */
async function loadTerms() { terms = await window.api.getTerms(); }
function renderTerms() {
  const tl = $('#termList');
  tl.innerHTML = (terms.terms || []).map((t, i) => `<span class="chip">${esc(t)}<button data-tdel="${i}" title="删除">×</button></span>`).join('') || '<span class="hint">还没有术语。</span>';
  const rl = $('#replaceList');
  const rep = terms.replace || {};
  const keys = Object.keys(rep);
  rl.innerHTML = keys.map((k) => `<span class="chip">${esc(k)} → ${esc(rep[k])}<button data-rdel="${esc(k)}" title="删除">×</button></span>`).join('') || '<span class="hint">还没有替换规则。</span>';
}

/* ---------------- 设置 ---------------- */
function renderSettings() {
  $('#setDevice').value = SETTINGS.device || 'auto';
  const sel = $('#setModel');
  sel.innerHTML = '';
  const autoOpt = document.createElement('option');
  autoOpt.value = 'auto';
  autoOpt.textContent = '自动（有 GPU 用 medium，否则 small）';
  sel.appendChild(autoOpt);
  MODELS.forEach((m) => {
    const o = document.createElement('option');
    o.value = m.key;
    o.textContent = m.key + '（约 ' + m.sizeMB + ' MB）';
    sel.appendChild(o);
  });
  if (!MODELS.some((m) => m.key === SETTINGS.modelKey) && SETTINGS.modelKey !== 'auto') {
    const o = document.createElement('option'); o.value = SETTINGS.modelKey; o.textContent = SETTINGS.modelKey; sel.appendChild(o);
  }
  sel.value = SETTINGS.modelKey || 'auto';
  $('#setOutDir').value = SETTINGS.outDir || '';
  $('#setHistoryDir').value = SETTINGS.historyDir || '';
  $('#setLang').value = SETTINGS.lang || 'zh';
  const fmts = (SETTINGS.formats || 'txt,srt').split(',');
  $('#setFmtTxt').checked = fmts.includes('txt');
  $('#setFmtSrt').checked = fmts.includes('srt');
  $('#setTerms').checked = !!SETTINGS.termsEnabled;
  $('#setPrompt').value = SETTINGS.aiPrompt || DEFAULT_AI_PROMPT;
  const g = $('#gpuStatus');
  if (GPU === true) { g.textContent = 'GPU：可用（已检测到 NVIDIA 加速）'; g.className = 'gpu-line ok'; }
  else if (GPU === false) { g.textContent = 'GPU：不可用（将使用 CPU）'; g.className = 'gpu-line warn'; }
  else { g.textContent = 'GPU：未知'; g.className = 'gpu-line'; }
  const md = $('#modelsDirHint');
  if (md && CONFIG) md.textContent = CONFIG.modelRoot ? '目录：' + CONFIG.modelRoot : '';
  renderModelList();
  renderGpuPack();
}

function renderModelList() {
  const el = $('#modelList');
  if (!el) return;
  if (!CATALOG.length) { el.innerHTML = '<div class="hint">模型清单加载中…</div>'; return; }
  el.innerHTML = CATALOG.map((m) => {
    const dl = modelDl[m.key] || {};
    const downloading = dl.status === 'downloading';
    const pct = typeof dl.pct === 'number' ? dl.pct : 0;
    let statusText = '未安装';
    let cls = '';
    if (m.installed) { statusText = '已安装' + (m.sizeMB ? '（约 ' + m.sizeMB + ' MB）' : ''); cls = 'ok'; }
    else if (downloading) { statusText = '下载中 ' + pct.toFixed(1) + '%'; cls = 'run'; }
    else if (dl.status === 'error') { statusText = '下载失败'; cls = 'err'; }
    const action = m.installed ? ''
      : (downloading
        ? `<button class="btn btn-ghost btn-sm" data-mcancel="${m.key}">取消</button>`
        : `<button class="btn btn-primary btn-sm" data-mdownload="${m.key}">下载</button>`);
    const prog = (downloading || dl.status === 'error')
      ? `<div class="mi-prog"><div class="bar"><i style="width:${downloading ? Math.max(1, Math.min(100, pct)) : 100}%"></i></div>${dl.status === 'error' ? '<span class="mi-err">' + esc(dl.message || '下载失败') + '</span>' : ''}</div>`
      : '';
    return `<div class="model-item" data-key="${esc(m.key)}">
      <div class="mi-info">
        <div class="mi-name">${esc(m.name)} <span class="mi-tag">${esc(m.key)}</span></div>
        <div class="mi-desc">${esc(m.desc)} · 约 ${m.totalMB} MB</div>
      </div>
      <div class="mi-right"><span class="mi-status ${cls}">${esc(statusText)}</span>${action}</div>
      ${prog}
    </div>`;
  }).join('');
}

function onModelEvent(ev) {
  if (!ev || !ev.key) return;
  const st = modelDl[ev.key] || (modelDl[ev.key] = {});
  if (ev.type === 'start') { st.status = 'downloading'; st.pct = 0; st.message = ''; }
  else if (ev.type === 'progress') { st.status = 'downloading'; st.pct = typeof ev.pct === 'number' ? ev.pct : st.pct || 0; }
  else if (ev.type === 'done') {
    st.status = 'idle'; st.pct = 100; st.message = '';
    toast('模型下载完成：' + ev.key);
    refreshSettings().then(() => { if (!$('#view-settings').hidden) renderSettings(); });
  } else if (ev.type === 'error') {
    if (/已取消/.test(ev.message || '')) { st.status = 'idle'; st.pct = 0; }
    else { st.status = 'error'; st.message = ev.message || '下载失败'; toast('模型下载失败：' + (ev.message || '')); }
  }
  if (!$('#view-settings').hidden) renderModelList();
}

async function saveSettingsFromForm() {
  const fmts = [];
  if ($('#setFmtTxt').checked) fmts.push('txt');
  if ($('#setFmtSrt').checked) fmts.push('srt');
  if (!fmts.length) fmts.push('txt');
  const patch = {
    device: $('#setDevice').value,
    modelKey: $('#setModel').value,
    outDir: $('#setOutDir').value.trim(),
    historyDir: $('#setHistoryDir').value.trim(),
    lang: $('#setLang').value,
    formats: fmts.join(','),
    termsEnabled: $('#setTerms').checked,
    aiPrompt: $('#setPrompt').value,
  };
  SETTINGS = await window.api.saveSettings(patch);
  fillHeaderSelects();
  updateHeadAndEnv();
  toast('设置已保存');
}

/* ---------------- 事件 ---------------- */
let toastTimer;
function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800); }

function wireUi() {
  $('#btnMin').addEventListener('click', () => window.api.winMinimize());
  $('#btnMax').addEventListener('click', () => window.api.winToggleMaximize());
  $('#btnClose').addEventListener('click', () => window.api.winClose());

  document.querySelectorAll('.sidebar .nav a[data-view]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); showView(a.dataset.view); });
  });

  const pick = async () => { const paths = await window.api.pickFiles(); await addPaths(paths); };
  $('#pick').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); pick(); });
  $('#stagedAdd').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); pick(); });
  $('#dropzone').addEventListener('click', (e) => {
    if (staged.length) return; // 已有待确认卡片时，不误触打开对话框
    if (e.target.closest('.dz-add')) return;
    pick();
  });
  $('#dropzone').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !staged.length) { e.preventDefault(); pick(); } });

  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('drag'); }));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  dz.addEventListener('drop', async (e) => {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    const paths = files.map((f) => window.api.getPathForFile(f)).filter(Boolean);
    if (paths.length) await addPaths(paths); else toast('没能读取到文件路径');
  });

  // 待确认卡片删除
  $('#stagedList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sdel]');
    if (!b) return;
    e.stopPropagation();
    const sid = Number(b.getAttribute('data-sdel'));
    staged = staged.filter((s) => s.sid !== sid);
    renderStaged();
  });

  $('#startAll').addEventListener('click', startAll);
  $('#clearDone').addEventListener('click', () => {
    const before = tasks.length;
    tasks = tasks.filter((t) => t.status !== 'done');
    render();
    toast(tasks.length < before ? '已清空完成的任务' : '没有已完成任务');
  });

  // 顶栏就地下拉
  $('#hdrDevice').addEventListener('change', async (e) => {
    SETTINGS = await window.api.saveSettings({ device: e.target.value });
    updateHeadAndEnv();
    if (!$('#view-settings').hidden) renderSettings();
    toast('设备：' + (DEVICE_LABEL[e.target.value] || e.target.value));
  });
  $('#hdrModel').addEventListener('change', async (e) => {
    SETTINGS = await window.api.saveSettings({ modelKey: e.target.value });
    updateHeadAndEnv();
    if (!$('#view-settings').hidden) renderSettings();
    toast('模型：' + (e.target.value === 'auto' ? '自动' : e.target.value));
  });

  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const row = e.target.closest('.task');
    if (!row) return;
    const t = tasks.find((x) => x.id === Number(row.dataset.id));
    if (!t) return;
    const act = btn.dataset.act;
    if (act === 'copy') {
      if (t.previewText == null) await readPreview(t);
      window.api.copyText(t.previewText || '');
      btn.classList.add('done'); btn.innerHTML = '已复制';
      toast(t.previewText ? '已复制全文，去网页 AI 粘贴即可' : '没有可复制的文本');
    } else if (act === 'copyprompt') {
      window.api.copyText(SETTINGS.aiPrompt || DEFAULT_AI_PROMPT);
      toast('已复制 AI 总结提示词，粘贴到聊天框即可');
    } else if (act === 'preview') { t.expanded = !t.expanded; if (t.expanded) await readPreview(t); render(); }
    else if (act === 'open') { const p = (t.outputs && (t.outputs.txt || Object.values(t.outputs)[0])) || t.path; window.api.showInFolder(p); }
    else if (act === 'remove') { if (t.status === 'running') window.api.cancelTask(t.id); tasks = tasks.filter((x) => x.id !== t.id); if (!tasks.some((x) => x.status === 'running')) running = false; render(); startNext(); }
    else if (act === 'retry') { t.status = 'queued'; t.progress = 0; t.error = ''; t.previewText = null; t.outputs = null; render(); startNext(); }
  });

  // 历史
  $('#clearHistory').addEventListener('click', async () => { await window.api.clearHistory(); renderHistory(); toast('已清空历史'); });
  $('#historyList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-hact]');
    if (!b) return;
    const item = e.target.closest('.hist');
    const list = await window.api.listHistory();
    const h = list[Number(item.dataset.i)];
    if (!h) return;
    const act = b.dataset.hact;
    if (act === 'open') { const p = (h.outputs && (h.outputs.txt || Object.values(h.outputs)[0])) || h.filePath; window.api.showInFolder(p); }
    else if (act === 'copy') { if (h.outputs && h.outputs.txt) { const txt = await window.api.readText(h.outputs.txt); window.api.copyText(txt); toast('已复制全文'); } else toast('找不到输出文件'); }
    else if (act === 'rerun') { showView('transcribe'); await addPaths([h.filePath]); }
  });

  // 术语
  $('#addTerm').addEventListener('click', () => {
    const v = $('#termInput').value.trim();
    if (!v) return;
    if (!terms.terms.includes(v)) terms.terms.push(v);
    $('#termInput').value = ''; renderTerms();
  });
  $('#termInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#addTerm').click(); } });
  $('#termList').addEventListener('click', (e) => {
    const i = e.target.getAttribute('data-tdel');
    if (i != null) { terms.terms.splice(Number(i), 1); renderTerms(); }
  });
  $('#addReplace').addEventListener('click', () => {
    const f = $('#replaceFrom').value.trim(), t = $('#replaceTo').value.trim();
    if (!f || !t) return;
    terms.replace[f] = t;
    $('#replaceFrom').value = ''; $('#replaceTo').value = ''; renderTerms();
  });
  $('#replaceList').addEventListener('click', (e) => {
    const k = e.target.getAttribute('data-rdel');
    if (k != null) { delete terms.replace[k]; renderTerms(); }
  });
  $('#saveTerms').addEventListener('click', async () => { terms = await window.api.saveTerms(terms); renderTerms(); toast('术语库已保存'); });

  // 设置
  $('#saveSettings').addEventListener('click', saveSettingsFromForm);
  $('#modelList').addEventListener('click', async (e) => {
    const d = e.target.closest('[data-mdownload]');
    const c = e.target.closest('[data-mcancel]');
    if (d) {
      const key = d.getAttribute('data-mdownload');
      modelDl[key] = { status: 'downloading', pct: 0 };
      renderModelList();
      toast('开始下载：' + key);
      try {
        const result = await window.api.downloadModel(key);
        if (result && result.ok === false) throw new Error(result.error || '无法开始下载');
      } catch (err) {
        modelDl[key] = { status: 'error', message: err.message || String(err) };
        renderModelList();
        toast('模型下载失败：' + (err.message || String(err)));
      }
    } else if (c) {
      const key = c.getAttribute('data-mcancel');
      await window.api.cancelModelDownload(key);
      toast('已取消：' + key);
    }
  });
  $('#refreshModels').addEventListener('click', async () => {
    await refreshSettings();
    renderSettings();
    toast(MODELS.length ? '模型列表已刷新' : '还没有完整模型，请先下载或导入');
  });
  // GPU 加速包
  $('#gpuPackActions').addEventListener('click', async (e) => {
    const d = e.target.closest('#gpuPackDownload');
    const c = e.target.closest('#gpuPackCancel');
    if (d) { toast('开始下载 GPU 加速包'); await window.api.downloadGpuPack(); }
    else if (c) { await window.api.cancelGpuPack(); toast('已取消'); }
  });
  $('#gpuPackImport').addEventListener('click', async () => {
    const r = await window.api.importGpuPack();
    if (r && r.ok) toast('GPU 加速包已导入');
    else if (r && r.error) toast('导入失败：' + r.error);
  });
  $('#gpuPackDir').addEventListener('click', async () => { const p = await window.api.openGpuPackDir(); toast('GPU 包目录：' + p); });
  $('#gpuPackRemove').addEventListener('click', async () => { await window.api.removeGpuPack(); toast('已移除 GPU 加速包'); });
  $('#openModelsDir').addEventListener('click', async () => {
    const p = await window.api.openModelsDir();
    toast('模型目录：' + p);
  });
  $('#pickOutDir').addEventListener('click', async () => { const d = await window.api.pickDir(); if (d) $('#setOutDir').value = d; });
  $('#clearOutDir').addEventListener('click', () => { $('#setOutDir').value = ''; });
  $('#pickHistoryDir').addEventListener('click', async () => { const d = await window.api.pickDir(); if (d) $('#setHistoryDir').value = d; });
  $('#clearHistoryDir').addEventListener('click', () => { $('#setHistoryDir').value = ''; });
  $('#openHistoryDir').addEventListener('click', async () => { const p = await window.api.revealHistory(); toast('历史位置：' + p); });
  $('#copyPrompt').addEventListener('click', () => { window.api.copyText($('#setPrompt').value || DEFAULT_AI_PROMPT); toast('已复制提示词'); });
  $('#resetPrompt').addEventListener('click', () => { $('#setPrompt').value = DEFAULT_AI_PROMPT; toast('已恢复默认提示词'); });

  setInterval(() => { if (tasks.some((t) => t.status === 'running')) render(); }, 1000);
}

(async function boot() {
  await init();
  await loadTerms();
})();
