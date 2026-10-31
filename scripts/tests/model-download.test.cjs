'use strict';
// Scope: main.js model readiness/download behavior through public IPC, without Electron GUI.
// Real loopback HTTP and real temp files; only Electron/config/child processes and injected
// filesystem faults are mocked. Catalog fixture sizes are reduced in the isolated VM so
// range, streaming and integrity checks run without allocating multi-GB model weights.
// Acceptance: incomplete weights rejected; offline metadata preserved; valid resume/restart;
// cancellation, malformed responses, backpressure, IO errors and no-clobber publication.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { setImmediate: tick } = require('node:timers/promises');

const MAIN = path.resolve(__dirname, '../../app/main.js');
const SOURCE = fs.readFileSync(MAIN, 'utf8');
const FIXTURES = {
  'config.json': Buffer.from('{"fixture":"downloaded"}' + ' '.repeat(4096)),
  'tokenizer.json': Buffer.from('{"fixture":"tokenizer"}' + ' '.repeat(1024 * 1024)),
  'vocabulary.txt': Buffer.from('fixture vocabulary\n'),
  'vocabulary.json': Buffer.from('["fixture"]'),
  'preprocessor_config.json': Buffer.from('{"fixture":"optional"}'),
  'model.bin': Buffer.alloc(256 * 1024, 37),
};

async function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atd-model-download-'));
  // All cleanup targets are the verified mkdtemp root, never the workspace's models.
  assert.equal(path.dirname(root), os.tmpdir());
  const requests = [];
  const networkCalls = [];
  const events = [];
  const eventBus = new EventEmitter();
  const handlers = new Map();
  const spawned = [];
  const sockets = new Set();
  let serve = (req, res) => {
    const name = decodeURIComponent(req.url.split('/').pop());
    const body = FIXTURES[name];
    if (!body) { res.writeHead(404); res.end(); return; }
    const start = req.headers.range ? Number(/^bytes=(\d+)-$/.exec(req.headers.range)[1]) : 0;
    if (start) res.writeHead(206, { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`, 'Content-Length': body.length - start });
    else res.writeHead(200, { 'Content-Length': body.length });
    res.end(body.subarray(start));
  };
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, range: req.headers.range });
    serve(req, res);
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cfg = {
    engineRoot: root, model: '', packaged: !!options.packaged,
    python: process.execPath, useEngineExe: false, cudaDir: '', outDir: path.join(root, 'out'), warnings: [],
  };
  const resourcesPath = path.join(root, 'resources');
  const models = path.join(cfg.packaged ? resourcesPath : root, 'models');
  const model = path.join(models, 'small');
  const fsMock = { ...fs, promises: { ...fs.promises }, ...options.fs };
  const electron = {
    app: { whenReady: () => Promise.resolve(), on() {}, getPath: () => path.join(root, 'userData') },
    BrowserWindow: class extends EventEmitter {
      constructor() { super(); this.webContents = { send(channel, value) {
        if (channel === 'model:event') { events.push(value); eventBus.emit('event', value); }
      } }; }
      loadFile() {} isDestroyed() { return false; }
      static getAllWindows() { return []; }
    },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    dialog: {}, clipboard: {}, shell: {},
    net: { async fetch(url, init) {
      assert.ok(url.startsWith('https://modelscope.cn/models/'), 'production download defaults to ModelScope');
      networkCalls.push({ url, init });
      return fetch(origin + new URL(url).pathname, init);
    } },
  };
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return electron;
      if (name === './config') return () => cfg;
      if (name === 'fs') return fsMock;
      if (name === 'child_process') return { spawn(cmd, args) {
        spawned.push({ cmd, args });
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
        setImmediate(() => { child.stdout.end('{"cuda":false}\n'); child.emit('close', 0); });
        return child;
      } };
      return require(name);
    },
    __dirname: path.dirname(MAIN), process: { platform: process.platform, env: { ...process.env }, resourcesPath },
    console, Buffer, AbortController,
    setTimeout: options.setTimeout || setTimeout, clearTimeout,
  });
  vm.runInContext(SOURCE, context, { filename: MAIN });
  const productionSizes = JSON.parse(vm.runInContext('JSON.stringify(MODEL_CATALOG.map(d => ({ key: d.key, files: d.files })))', context));
  // Fixture data injection only; source and all production behavior remain unchanged.
  context.fixtureSizes = Object.fromEntries(Object.entries(FIXTURES).map(([name, bytes]) => [name, bytes.length]));
  vm.runInContext('MODEL_CATALOG.forEach(d => d.files.forEach(f => { f.size = fixtureSizes[f.path]; }))', context);
  await tick();
  const invoke = (name, ...args) => handlers.get(name)({}, ...args);
  const waitEvent = (predicate, from = events.length) => new Promise((resolve, reject) => {
    const found = events.slice(from).find(predicate);
    if (found) { resolve(found); return; }
    const timer = setTimeout(() => { eventBus.off('event', onEvent); reject(new Error('Timed out waiting for model event: ' + JSON.stringify(events))); }, 5000);
    function onEvent(event) {
      if (!predicate(event)) return;
      clearTimeout(timer); eventBus.off('event', onEvent); resolve(event);
    }
    eventBus.on('event', onEvent);
  });
  const terminal = (from = events.length) => waitEvent((e) => e.type === 'done' || e.type === 'error', from);
  const download = async (key = 'small') => {
    const done = terminal();
    assert.equal(invoke('model:download', key).ok, true);
    const result = await done;
    await tick(); // allow downloadModel's finally to release the public IPC lock
    return result;
  };
  function seed(key = 'small', omit = []) {
    const dir = path.join(models, key);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['config.json', 'tokenizer.json', key === 'large-v3' ? 'vocabulary.json' : 'vocabulary.txt', 'model.bin']) {
      if (!omit.includes(name)) fs.writeFileSync(path.join(dir, name), FIXTURES[name]);
    }
    return dir;
  }
  t.after(async () => {
    for (const key of ['small', 'medium', 'large-v3']) invoke('model:cancel', key);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    // Resolve the actual cleanup target and constrain it to the temp root created above.
    assert.ok(fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, cfg, models, model, productionSizes, context, fsMock, events, networkCalls, requests, spawned,
    invoke, waitEvent, terminal, download, seed, serve: (fn) => { serve = fn; } };
}

function installed(h, key = 'small') {
  return h.invoke('models:catalog').find((entry) => entry.key === key).installed;
}
function assertDone(event) { assert.equal(event.type, 'done', event.message); }
function assertError(event, message) { assert.equal(event.type, 'error'); assert.match(event.message, message); }

test('catalog, list and transcribe reject incomplete weights and missing required offline files', async (t) => {
  const h = await harness(t);
  h.seed();
  assert.equal(h.productionSizes.find((d) => d.key === 'small').files.find((f) => f.path === 'model.bin').size, 483546902);
  fs.writeFileSync(path.join(h.model, 'model.bin'), 'truncated');
  assert.equal(installed(h), false);
  assert.equal(h.invoke('models:list').length, 0);
  const input = path.join(h.root, 'input.wav'); fs.writeFileSync(input, 'fixture');
  const missing = await h.invoke('transcribe:start', { id: 'missing', filePath: input });
  assert.equal(missing.ok, false); assert.match(missing.error, /还没有可用模型/);
  fs.writeFileSync(path.join(h.model, 'model.bin'), FIXTURES['model.bin']);
  for (const name of ['config.json', 'tokenizer.json', 'vocabulary.txt']) {
    fs.renameSync(path.join(h.model, name), path.join(h.model, name + '.saved'));
    assert.equal(installed(h), false, name + ' must be present');
    fs.renameSync(path.join(h.model, name + '.saved'), path.join(h.model, name));
  }
  fs.writeFileSync(path.join(h.model, 'tokenizer.json'), '{truncated');
  assert.equal(installed(h), false);
  assert.equal(h.networkCalls.length, 0, 'readiness and transcribe never initiate downloads');
});

test('offline models accept differing metadata sizes and optional preprocessor absence in packaged resources', async (t) => {
  const h = await harness(t, { packaged: true });
  const dir = h.seed('large-v3');
  fs.writeFileSync(path.join(dir, 'config.json'), '{"offline":true}');
  fs.writeFileSync(path.join(dir, 'tokenizer.json'), '{"offline":"different conversion"}');
  assert.equal(installed(h, 'large-v3'), true);
  assert.equal(h.invoke('models:list')[0].key, 'large-v3');
  assert.equal(h.invoke('config:get').modelRoot, h.models);
  assertDone(await h.download('large-v3'));
  assert.equal(h.networkCalls.length, 0, 'already usable offline model does not request optional files');
  const input = path.join(h.root, 'input.wav'); fs.writeFileSync(input, 'fixture');
  const result = await h.invoke('transcribe:start', { id: 'offline', filePath: input });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'large-v3');
  assert.ok(h.spawned.some((s) => s.args.includes(dir)), 'resolver uses the same usable model predicate');
});

test('fresh HTTP download validates and publishes missing files, preserving valid existing metadata', async (t) => {
  const h = await harness(t);
  h.seed('small', ['config.json', 'model.bin']);
  const tokenizer = Buffer.from('{"user":"keep me"}');
  fs.writeFileSync(path.join(h.model, 'tokenizer.json'), tokenizer);
  assertDone(await h.download());
  assert.deepEqual(fs.readFileSync(path.join(h.model, 'tokenizer.json')), tokenizer);
  assert.deepEqual(fs.readFileSync(path.join(h.model, 'config.json')), FIXTURES['config.json']);
  assert.equal(fs.existsSync(path.join(h.model, 'model.bin.part')), false);
  assert.equal(installed(h), true);
  assert.deepEqual(h.requests.map((r) => r.url.split('/').pop()), ['config.json', 'model.bin']);
});

test('valid 206 resumes from exact byte offset and preserves the prefix', async (t) => {
  const h = await harness(t);
  h.seed('small', ['model.bin']);
  const offset = 777;
  fs.writeFileSync(path.join(h.model, 'model.bin.part'), FIXTURES['model.bin'].subarray(0, offset));
  assertDone(await h.download());
  assert.equal(h.requests[0].range, 'bytes=' + offset + '-');
  assert.deepEqual(fs.readFileSync(path.join(h.model, 'model.bin')), FIXTURES['model.bin']);
});

test('ignored Range restarts part with 200 instead of appending duplicate bytes', async (t) => {
  const h = await harness(t);
  h.seed('small', ['model.bin']);
  fs.writeFileSync(path.join(h.model, 'model.bin.part'), Buffer.from('old invalid prefix'));
  h.serve((_req, res) => { res.writeHead(200, { 'Content-Length': FIXTURES['model.bin'].length }); res.end(FIXTURES['model.bin']); });
  assertDone(await h.download());
  assert.deepEqual(fs.readFileSync(path.join(h.model, 'model.bin')), FIXTURES['model.bin']);
});

for (const range of ['missing', 'bytes 8-262143/262144', 'bytes 7-262142/262144', 'bytes 7-262143/262145']) {
  test('incorrect Content-Range is rejected before modifying the part: ' + range, async (t) => {
    const h = await harness(t);
    h.seed('small', ['model.bin']);
    const prefix = Buffer.from('1234567');
    fs.writeFileSync(path.join(h.model, 'model.bin.part'), prefix);
    h.serve((_req, res) => { res.writeHead(206, range === 'missing' ? {} : { 'Content-Range': range }); res.end('wrong data'); });
    assertError(await h.download(), /Content-Range/);
    assert.deepEqual(fs.readFileSync(path.join(h.model, 'model.bin.part')), prefix);
    assert.equal(fs.existsSync(path.join(h.model, 'model.bin')), false);
    assert.equal(installed(h), false);
  });
}

test('a complete model.bin.part is recovered without a network request or HTTP 416', async (t) => {
  const h = await harness(t);
  h.seed('small', ['model.bin']);
  fs.writeFileSync(path.join(h.model, 'model.bin.part'), FIXTURES['model.bin']);
  assertDone(await h.download());
  assert.equal(h.networkCalls.length, 0);
  assert.deepEqual(fs.readFileSync(path.join(h.model, 'model.bin')), FIXTURES['model.bin']);
});

test('full part with invalid JSON is not published', async (t) => {
  const h = await harness(t);
  h.seed('small', ['config.json']);
  fs.writeFileSync(path.join(h.model, 'config.json.part'), Buffer.alloc(FIXTURES['config.json'].length, 120));
  assertError(await h.download(), /内容无效/);
  assert.equal(h.networkCalls.length, 0);
  assert.equal(fs.existsSync(path.join(h.model, 'config.json')), false);
});

test('cancel during transfer closes the file before error and immediate retry resumes it', async (t) => {
  let wrote;
  const diskWrite = new Promise((resolve) => { wrote = resolve; });
  const h = await harness(t, { fs: { createWriteStream(file, options) {
    const stream = fs.createWriteStream(file, options);
    const write = stream._write;
    stream._write = function (chunk, encoding, callback) {
      write.call(this, chunk, encoding, (err) => { if (!err) wrote(); callback(err); });
    };
    return stream;
  } } });
  h.seed('small', ['tokenizer.json']);
  let first = true;
  h.serve((req, res) => {
    const bytes = FIXTURES['tokenizer.json'];
    if (first) {
      first = false;
      res.writeHead(200, { 'Content-Length': bytes.length }); res.write(bytes.subarray(0, 1024));
      // Leave the connection open until the test cancels through public IPC.
    } else {
      const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range)[1]);
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}`, 'Content-Length': bytes.length - start });
      res.end(bytes.subarray(start));
    }
  });
  const progress = h.waitEvent((e) => e.type === 'progress' && e.file === 'tokenizer.json');
  const cancelled = h.terminal();
  h.invoke('model:download', 'small');
  await progress;
  // The write callback gives cancellation a deterministic nonzero on-disk checkpoint.
  const part = path.join(h.model, 'tokenizer.json.part');
  await diskWrite;
  h.invoke('model:cancel', 'small');
  assertError(await cancelled, /已取消/);
  const checkpoint = fs.statSync(part).size;
  assert.ok(checkpoint > 0 && checkpoint < FIXTURES['tokenizer.json'].length);
  const retry = h.terminal();
  h.invoke('model:download', 'small');
  assertDone(await retry);
  assert.equal(h.requests[1].range, `bytes=${checkpoint}-`);
  assert.deepEqual(fs.readFileSync(path.join(h.model, 'tokenizer.json')), FIXTURES['tokenizer.json']);
  assert.equal(h.events.filter((e) => e.type === 'error').length, 1);
});

test('connection reset retains a checkpoint and a retry completes it', async (t) => {
  const h = await harness(t);
  h.seed('small', ['model.bin']);
  let first = true;
  h.serve((req, res) => {
    const bytes = FIXTURES['model.bin'];
    if (first) {
      first = false;
      res.writeHead(200, { 'Content-Length': bytes.length });
      res.write(bytes.subarray(0, 1024));
      h.waitEvent((e) => e.type === 'progress' && e.file === 'model.bin').then(() => res.socket.destroy());
    } else {
      const start = req.headers.range ? Number(/^bytes=(\d+)-$/.exec(req.headers.range)[1]) : 0;
      res.writeHead(start ? 206 : 200, start ? { 'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {});
      res.end(bytes.subarray(start));
    }
  });
  assertError(await h.download(), /下载 model.bin 失败/);
  assert.equal(fs.existsSync(path.join(h.model, 'model.bin')), false);
  assert.equal(installed(h), false);
  assertDone(await h.download());
  assert.deepEqual(fs.readFileSync(path.join(h.model, 'model.bin')), FIXTURES['model.bin']);
});

test('pipeline respects write stream backpressure and publishes only after close', async (t) => {
  let stalls = 0; let maxBuffered = 0; let closes = 0;
  const h = await harness(t, { fs: { createWriteStream(file, options) {
    const stream = fs.createWriteStream(file, { ...options, highWaterMark: 1 });
    const write = stream.write;
    const writeChunk = stream._write;
    stream._write = function (...args) { setImmediate(() => writeChunk.apply(this, args)); };
    stream.write = function (...args) {
      const result = write.apply(this, args);
      if (!result) stalls++;
      maxBuffered = Math.max(maxBuffered, this.writableLength);
      return result;
    };
    stream.on('close', () => closes++);
    return stream;
  } } });
  h.seed('small', ['tokenizer.json']);
  assertDone(await h.download());
  assert.ok(stalls > 1, 'write() returned false repeatedly');
  assert.ok(maxBuffered <= 256 * 1024, 'bounded buffering despite slow disk: ' + maxBuffered);
  assert.equal(closes, 1, 'file closed before model done');
  assert.deepEqual(fs.readFileSync(path.join(h.model, 'tokenizer.json')), FIXTURES['tokenizer.json']);
});

for (const code of ['EACCES', 'ENOSPC']) {
  test('write stream ' + code + ' has an actionable message, closes, and can retry', async (t) => {
    let first = true; let closed = false;
    const h = await harness(t, { fs: { createWriteStream(file, options) {
      const stream = fs.createWriteStream(file, options);
      if (first) {
        first = false;
        stream._write = (_chunk, _encoding, callback) => callback(Object.assign(new Error('injected write failure'), { code }));
        stream.on('close', () => { closed = true; });
      }
      return stream;
    } } });
    h.seed('small', ['model.bin']);
    assertError(await h.download(), code === 'EACCES' ? /没有读写权限/ : /磁盘空间不足/);
    assert.equal(closed, true);
    assert.equal(fs.existsSync(path.join(h.model, 'model.bin')), false);
    assertDone(await h.download());
  });
}

test('directory permission failure is reported before any network request', async (t) => {
  const h = await harness(t);
  h.fsMock.mkdirSync = () => { throw Object.assign(new Error('denied fixture'), { code: 'EACCES' }); };
  assertError(await h.download(), /模型目录没有读写权限/);
  assert.equal(h.networkCalls.length, 0);
});

test('existing invalid final file is preserved with explicit instructions instead of silently overwritten', async (t) => {
  const h = await harness(t);
  h.seed();
  const original = Buffer.from('user incomplete model');
  fs.writeFileSync(path.join(h.model, 'model.bin'), original);
  assertError(await h.download(), /目标文件已存在但不完整或不可用.*先移动/);
  assert.deepEqual(fs.readFileSync(path.join(h.model, 'model.bin')), original);
  assert.equal(h.networkCalls.length, 0);
});

test('a valid file appearing during download is preserved by no-clobber publication', async (t) => {
  const h = await harness(t);
  h.seed('small', ['config.json']);
  const original = Buffer.from('{"user":"appeared while downloading"}');
  h.fsMock.promises.link = async (part, dest) => {
    fs.writeFileSync(dest, original);
    return fs.promises.link(part, dest);
  };
  assertDone(await h.download());
  assert.deepEqual(fs.readFileSync(path.join(h.model, 'config.json')), original);
});

test('filesystems without hard links use exclusive copy without overwriting files', async (t) => {
  const h = await harness(t);
  h.seed('small', ['model.bin']);
  h.fsMock.promises.link = async () => { throw Object.assign(new Error('unsupported fixture'), { code: 'ENOTSUP' }); };
  assertDone(await h.download());
  assert.deepEqual(fs.readFileSync(path.join(h.model, 'model.bin')), FIXTURES['model.bin']);
});

test('incorrect Content-Length, short and oversized bodies never install the model', async (t) => {
  for (const mode of ['length', 'short', 'oversized']) {
    await t.test(mode, async (t) => {
      const h = await harness(t);
      h.seed('small', ['model.bin']);
      h.serve((_req, res) => {
        if (mode === 'length') { res.writeHead(200, { 'Content-Length': 3 }); res.end('bad'); }
        else if (mode === 'short') { res.writeHead(200); res.end('short fixture'); }
        else { res.writeHead(200); res.end(Buffer.alloc(FIXTURES['model.bin'].length + 1)); }
      });
      assertError(await h.download(), mode === 'length' ? /Content-Length/ : mode === 'short' ? /文件大小不符/ : /超过预期/);
      assert.equal(installed(h), false);
      assert.equal(fs.existsSync(path.join(h.model, 'model.bin')), false);
    });
  }
});

test('stalled fetch is aborted by its idle timeout and reports a retryable error', async (t) => {
  let expire;
  const h = await harness(t, { setTimeout(fn, ms) {
    if (ms === 60000) { expire = fn; return setTimeout(() => {}, 10000); }
    return setTimeout(fn, ms);
  } });
  h.seed('small', ['model.bin']);
  let arrived;
  const requestArrived = new Promise((resolve) => { arrived = resolve; });
  h.serve((_req, _res) => arrived());
  const result = h.terminal(); h.invoke('model:download', 'small');
  await requestArrived;
  expire();
  assertError(await result, /下载超时.*检查网络后重试/);
});

test('duplicate start is locked until cancellation finishes; invalid keys do not access network', async (t) => {
  const h = await harness(t);
  h.seed('small', ['model.bin']);
  let arrived;
  const requestArrived = new Promise((resolve) => { arrived = resolve; });
  h.serve((_req, _res) => arrived());
  const result = h.terminal();
  h.invoke('model:download', 'small');
  await requestArrived;
  h.invoke('model:download', 'small');
  assert.equal(h.networkCalls.length, 1);
  h.invoke('model:cancel', 'small');
  assertError(await result, /已取消/);
  assertError(await h.download('../../escape'), /未知模型/);
  assert.equal(h.networkCalls.length, 1);
});
