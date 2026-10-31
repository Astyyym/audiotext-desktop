# app · 前端壳（Electron，M2 MVP）

Electron 主界面壳：拖拽/选择音视频入队 → 通过 **stdio(JSON 行)** 调用 Python 引擎 `engine.cli` → 进度/结果实时回显 → 复制全文、预览、打开目录。

主界面依据已评审设计稿 `../designs/audio-text-desktop/Main Window.html` 实现。

## 运行前置
1. Python 引擎环境已就绪（`../engine/requirements.txt` 已装，见 `../engine/README.md`）。
2. 本机 `ffmpeg` / `ffprobe` 可用（PATH 中）。
3. 准备一个本地 faster-whisper 模型目录（含 `model.bin` / `config.json` / `tokenizer.json` / `vocabulary.txt`）。

## 配置
复制 `config.local.example.json` 为 `config.local.json`（已被 `.gitignore` 忽略，**不要提交**），填入本机路径：

```json
{
  "python": "C:\\path\\to\\venv\\Scripts\\python.exe",
  "model": "C:\\path\\to\\faster-whisper-small",
  "device": "auto",
  "formats": "txt,srt",
  "cudaDir": ""
}
```

字段说明：
| 字段 | 说明 |
|---|---|
| `python` | 装了 faster-whisper 的 Python 解释器 |
| `model` | 本地模型目录 |
| `device` | `auto` / `cuda` / `cpu` |
| `formats` | 输出格式，默认 `txt,srt` |
| `outDir` | 默认输出目录；空则用「源文件同目录/文字稿」 |
| `cudaDir` | GPU 时 CUDA 运行库 DLL 目录（开发可指向 torch/lib） |
| `extraPath` | 追加到 PATH 的目录（可选） |
| `ffprobe` | ffprobe 可执行路径，默认走 PATH |

也可用环境变量覆盖（`ATD_PYTHON` / `ATD_MODEL` / `ATD_DEVICE` / `ATD_OUT` / `ATD_CUDA_DIR` / `ATD_EXTRA_PATH`）。

## 安装与启动
```bash
cd app
npm install          # 安装 electron
npm start            # 启动应用
```

## 功能范围
- 拖拽 / 选择多个音视频入队（25 种格式）。
- 串行执行（一次一个文件）；进度条、实时倍率、剩余时间。
- 完成后：复制全文、展开/收起结果预览、打开所在文件夹、移除。
- 失败可重试；清空已完成。
- **设置**：设备（自动/GPU/CPU）、模型（auto/small/medium/large-v3）、输出目录、语言、输入输出格式、术语校正开关；持久化到 userData。
- **历史记录**：本地保存最近 300 条（文件名/模型/设备/耗时/字数/输出），可打开输出、复制全文、重转、清空。
- **术语库**：维护「术语提示词」与「误写→正写」替换规则，转写时作为 `--terms` 传给引擎。
- GPU：打包内置 `cuda/`（cublas），`device=auto` 时 NVIDIA 机器自动用 GPU；`auto` 模型在 GPU 上选 medium（未装则 small）、无 GPU 用 small。
- 全程本地调用引擎，运行期不联网、不上传。

## 架构
```
renderer/ (index.html / styles.css / app.js)  ── 界面与任务状态、串行调度
        │  window.api（preload contextBridge）
        ▼
main.js  ── BrowserWindow / IPC / spawn `python -m engine.cli ... --progress-json`
        │  逐行解析 stdout JSON → webContents.send('transcribe:event')
        ▼
../engine  （faster-whisper + ffmpeg）
```
- 拖拽文件路径：Electron 32+ 已移除 `File.path`，改用 `webUtils.getPathForFile`（在 preload 暴露）。
- 安全：`contextIsolation:true`、`nodeIntegration:false`，渲染层只能通过 `window.api` 调受限能力。

## 非目标（留给后续阶段）
- 安装器与代码签名（M3）；
- 术语库 / 历史记录 / 设置页（当前为导航占位）；
- 并发多任务、断点续跑、md/json 导出开关。
