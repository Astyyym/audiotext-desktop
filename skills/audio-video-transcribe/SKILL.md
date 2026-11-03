---
name: audio-video-transcribe
description: 把本地音视频批量转成文字（ASR）：ffprobe 取时长、ffmpeg 抽 16k 单声道 wav、faster-whisper(CTranslate2) 带时间戳转写（GPU/CPU 自动）、过滤静音幻觉、合并段落、可选术语校正，导出 txt/srt/md。用于转写、出字幕、整理文字稿；不涉及桌面项目打包。
---

# Audio/Video → Text (faster-whisper)

把本地音视频批量转成文字稿的通用流程。核心是 **ASR 语音识别**（读音频轨转文字，不做视频画面 OCR）。

## 何时使用
- 用户给出本地音视频（m4a/mp4/mov/wav/mp3/aac/flac/mkv/webm/amr/opus/wma/3gp…），要求"转成文字 / 出字幕 / 整理文字稿"。
- 需要中文为主、带时间戳、可批量、尽量本地离线。

## 不适用
- 视频画面文字（OCR）、说话人分离（需 pyannote 等另接）、翻译。
- 桌面 App 打包（那是另一套工程，不在本技能范围）。

## 依赖与环境
- Python 3.11 独立 venv；装包（国内建议加镜像更快）：
  ```bash
  python -m pip install faster-whisper ctranslate2 av onnxruntime \
    --index-url https://pypi.tuna.tsinghua.edu.cn/simple
  ```
- 系统 `ffmpeg` / `ffprobe`（或设 `FFMPEG`/`FFPROBE` 指向可执行文件）。
- 模型：**CTranslate2 格式** 的 Whisper（如 large-v3，目录含 `model.bin`/`config.json`/`tokenizer.json`/`vocabulary.json`/`preprocessor_config.json`）。用 `ATD_MODEL` 或 `--model` 指定目录，**不要写死路径**。
- GPU：需 NVIDIA 驱动 + CUDA12/cuDNN9 运行库 DLL。可复用已装 torch 的 `torch/lib`（把目录放进 `ATD_CUDA_DIR`），或发布时内置 `cuda/` 目录；无需用户装 CUDA Toolkit。无 GPU 时自动回落 CPU。

## 流程（按序执行）
1. **ffprobe 取时长**（做进度/元信息）。
2. **ffmpeg 抽 16k 单声道 wav**：
   `ffmpeg -y -v error -i <输入> -vn -ac 1 -ar 16000 -c:a pcm_s16le <wav>`
3. **faster-whisper 转写**（生成器逐段输出，带 start/end/text）：
   - `language="zh"`（或 `None` 自动识别）
   - `vad_filter=True`、`vad_parameters=dict(min_silence_duration_ms=400)`
   - `beam_size=5`、`condition_on_previous_text=False`
   - `initial_prompt="以下是普通话对话。"`（可按场景改）
   - GPU：`device="cuda", compute_type="float16"`（小显存 `int8_float16`）；CPU：`device="cpu", compute_type="int8"`
4. **过滤静音幻觉**：丢弃"请不吝点赞 / 订阅转发 / 打赏支持 / Amara.org / 谢谢观看"等，以及纯语气词。
5. **合并段落**：相邻段间隔 ≤ 5s 且合并后 ≤ 240 字合为一段（faster-whisper 原生切得很碎，必须合并才好读）。
6. **（可选）术语校正**：维护一份 `terms.json`，三级规则——`auto` 直接替换（人名/库名/同音字）、`context` 按上下文命中才替换、`review` 只报告不改；再人工修正明显错句。示例见 `references/terms.example.json`。
7. **导出文件**：`<原名>.txt`（纯文本段落，主产出、方便复制给外部 AI）、`<原名>.srt`（字幕）、可选 `.md`（带 `[mm:ss]`）、`.json`（meta+segments）。

## 参考实现
本技能附带可直接运行的脚本：`scripts/transcribe.py`（单文件，封装第 1–7 步核心）。
```bash
python scripts/transcribe.py --input <音视频> --out <输出目录> \
  --model <模型目录> --lang zh --device auto --formats txt,srt,md
```
环境变量：`ATD_MODEL`（默认模型目录）、`ATD_CUDA_DIR`（GPU 的 CUDA DLL 目录）、`FFMPEG`/`FFPROBE`。
项目里也有成品引擎可参考：`engine/`（`python -m engine.cli transcribe ...`，带 JSON 行进度事件）。

## 验证清单（用真实文件，别只看语法）
- [ ] 生成 txt 非空、可读，无明显大段漏句；
- [ ] srt 时间轴单调递增、条数与片段一致；
- [ ] GPU 路径能跑；无 GPU 时 `--device cpu` 也能出稿；
- [ ] 临时 wav 已清理；输出编码为 UTF-8（txt 可选 BOM）。

## 常见坑
1. PyPI 官方源慢 → 用清华镜像。
2. CUDA 库找不到 → 设 `ATD_CUDA_DIR` 指向 `torch/lib` 或内置的 `cuda/`（含 cublas64_12/cudnn64_9 等）。
3. Windows 中文乱码 → 写文件 `encoding="utf-8"`；子进程设 `PYTHONIOENCODING=utf-8`。
4. 段落太碎 → 合并用 间隔≤5s、≤240 字；别用 2.5s/110。
5. 首段幻觉 → 静音/片头常出现"请不吝点赞…"，务必过滤。
6. 大文件 → VAD 切片 + 边转边写盘，`finally` 清理临时 wav。
7. 不要硬编码本机绝对路径；模型/ffmpeg 用参数或环境变量。
