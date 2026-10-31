# engine · 音视频转文字引擎（M1 原型）

把音视频转成 `txt / srt / md / json`，支持 GPU/CPU 自动切换与 JSON 行进度事件。供 Electron 壳通过 stdio 调用。

## 依赖
```bash
python -m pip install -r engine/requirements.txt \
  --index-url https://pypi.tuna.tsinghua.edu.cn/simple
```
另需系统 `ffmpeg` / `ffprobe`（或设 `FFMPEG`/`FFPROBE` 环境变量）。

## 运行（在 Desktop/ 根目录）
```bash
python -m engine.cli transcribe \
  --input "path/to/audio.m4a" \
  --out "path/to/outdir" \
  --lang zh \
  --device auto \
  --model "path/to/faster-whisper-large-v3" \
  --formats txt,srt,json \
  --progress-json
```

## 环境变量
| 变量 | 说明 |
|---|---|
| `ATD_MODEL` | 默认模型目录（`--model` 未给时使用） |
| `ATD_CUDA_DIR` | GPU 时 CUDA 运行库 DLL 目录（发布版为安装目录 `cuda/`；开发可指向 torch/lib） |
| `FFMPEG` / `FFPROBE` | 自定义可执行路径 |

## 输出
- `txt`：纯文本段落（UTF-8，可选 BOM）
- `srt`：标准字幕
- `md`：带 `[mm:ss]` 分段
- `json`：`meta` + `segments[]{start,end,text}`

## 进度事件（stdout，每行一个 JSON）
```json
{"type":"status","stage":"device","device":"cuda","compute_type":"float16"}
{"type":"segment","start":12.3,"end":15.0,"text":"…","progress":42.1}
{"type":"done","outputs":{...},"segments":21,"chars":172,"elapsed_sec":10.0,"speed_x":10.4}
```
失败时输出 `{"type":"error","message":"…"}`，退出码非 0。

## 说明 / 待办
- 已内置 whisper 静音幻觉过滤（如"请不吝点赞…"）。
- 术语校正（terms.json）为 P2，暂未纳入。
- 引擎尚未包含 UI；M2 由 Electron 壳调用。
