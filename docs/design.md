# 技术设计

> 在 `docs/PRD.md` 范围内描述技术方案。输出格式与架构细节在此定义；与 PRD 冲突时以 PRD 为准。

## 1. 总体架构
```
┌────────────────────────────┐
│ 前端壳（Electron）         │  拖拽、队列、进度、复制
└─────────────┬──────────────┘
              │ stdio(JSON 行) 或 localhost HTTP + SSE
┌─────────────▼──────────────┐
│ Python sidecar（转写引擎） │
│  audio.py      ffprobe/ffmpeg
│  transcribe.py faster-whisper
│  formats.py    txt/srt/md/json
│  terms.py      术语校正（可选）
│  device.py     硬件探测/档位
│  cli.py        对外命令/事件
└─────────────┬──────────────┘
              │
   ffmpeg 静态二进制（随包内置）；CUDA 运行库（可选 GPU 加速包，按需下载/导入）；模型（独立下载或导入）
```

## 2. 选型
| 层 | 选型 | 说明 |
|---|---|---|
| 前端壳 | Electron | 生态成熟、热门、上手快；体积较大但可接受 |
| 引擎 | faster-whisper + CTranslate2 | 一套代码支持 GPU/CPU |
| 音视频 | ffmpeg 静态二进制（LGPL） | 解码、转 16k 单声道 wav；时长用 `ffmpeg -i` 解析（不再随包 ffprobe，减小体积） |
| VAD | faster-whisper 内置 Silero VAD | 切片、去静音 |
| 通信 | stdio JSON 行（简单）/ HTTP+SSE（易扩展） | 进度事件实时回传 |
| 打包 | Inno Setup / NSIS | 一个安装包 + 可选组件 |

## 3. 设备与模型策略
```
启动探测：
  NVIDIA + CUDA 初始化成功 → GPU 档
      ├─ 显存 ≥8G：large-v3 / float16
      └─ 显存 4–8G：medium / int8_float16
  否则 → CPU 档（small / int8，可切 medium）
（二期）Intel/AMD 核显 → whisper.cpp(Vulkan) 或 OpenVINO
```
用户可手动选择设备与已安装模型。模型自动档：有 GPU 时优先 medium、large-v3、small；无 GPU 时优先 small、medium、large-v3。上图显存建议用于手动选型，不代表自动探测显存容量。

## 4. 引擎双轨
| 轨 | 后端 | 适用 | 阶段 |
|---|---|---|---|
| A（主） | faster-whisper + CT2（CUDA/CPU） | 独显 / 纯 CPU | 一期 |
| B | whisper.cpp（Vulkan/OpenCL/Metal，量化 GGUF） | 核显、老机器、Mac | 二期 |
| C | OpenVINO 版 whisper | Intel 核显 | 二期 |

## 5. 处理流水线
1. 用 `ffmpeg -i` 解析音视频时长；
2. `ffmpeg -y -v error -i <in> -vn -ac 1 -ar 16000 -c:a pcm_s16le <tmp.wav>`；
3. faster-whisper 转写（生成器，逐段产出）；
4. 段落合并：相邻段间隔 ≤5s 且合并后 ≤240 字合为一段；
5. （可选）术语校正；
6. 输出文件；
7. 清理临时 wav。

转写参数：`language="zh"`、`vad_filter=True`、`min_silence_duration_ms=400`、`beam_size=5`、`condition_on_previous_text=False`、可配置场景提示词（如"以下是普通话面试对话"）。`compute_type`：GPU `float16`（小显存 `int8_float16`）、CPU `int8`。

## 6. 输出规范（详细）
每个音视频输出一组文件：

| 文件 | 默认 | 内容 |
|---|---|---|
| `<原名>.txt` | 是 | 纯文本、无时间戳、UTF-8（可选 BOM，默认开） |
| `<原名>.srt` | 是 | 标准字幕：序号 + 时间轴 + 文本 |
| `<原名>.md` | 否 | 带 `[mm:ss]` 的分段文本 |
| `<原名>.json` | 否 | `meta` + `segments[]{start,end,text}` |

- 输出目录：用户选择（默认源文件同目录的 `文字稿/`）；命名冲突加 ` (1)`。
- `meta` 含：源文件、时长、语言、模型、设备、耗时、实时倍率、字符数。
- 「复制全文」= 复制 `.txt` 内容；「复制带时间戳」= 取 `.md`/`.srt`。

## 7. 打包方案（概要）
- 基础安装包（NSIS）内置：程序、引擎、ffmpeg；**不内置 CUDA 运行库**，默认走 CPU。基础包因此显著小于旧版（GPU 由可选组件提供）。
- **可选 GPU 加速包**（CUDA 12 运行库：`cublas64_12.dll` + `cublasLt64_12.dll`，见 findings F18）作为独立 7z（LZMA 压缩，比 zip 小约 20%）分发。设置页「硬件加速」可在线下载或离线导入；安装到 `userData/gpu/cuda/`，运行时 `cudaDir` 解析顺序：环境/配置 > `userData/gpu/cuda` > `resourcesPath/cuda`（兼容旧版全量安装）。
- GPU 可用性判定必须同时满足"cuda 目录存在且含 cublas"与"设备可用"；无 cublas 时 `device=auto` 归一到 CPU（避免 findings F16 的 `get_cuda_device_count` 误判）。前端在 GPU 不可用时禁用 GPU 选择并提示下载加速包。
- 模型页默认从魔搭 ModelScope 下载 small / medium / large-v3 的 CTranslate2 文件到 `resources/models/<key>/`，支持取消、断点续传；仅用户主动点击时联网。
- 离线包顶层包含 `small/`、`medium/`、`large-v3/`，解压至 `resources/models/`，刷新模型列表或重启即可识别。
- 不使用单文件 onefile（每次启动解压大体积资源较慢）。GPU 包同样不使用 onefile，解压到固定目录后校验两个 DLL 再原子替换（.7z 用系统内置 `tar.exe` 解压，无需额外解压工具）。Windows 安装器由 `scripts/build-app.ps1` 生成，GPU 包由 `scripts/build-gpu-pack.ps1` 生成并写入 `app/gpu-pack.json`；第三方资源按各自许可分发。

## 8. 安全与隐私
- 全本地、不埋点、不上传；临时音频任务结束即删；输出写用户指定目录。

## 9. UI 原型（主界面）
- 早期结构原型：`designs/audio-text-desktop/Main Window.html`（匿名演示内容，可直接打开）；当前产品界面以 README 中真实 Windows Electron 截图为准，旧原型预览图仅本地保留。
- 已确认方向：浅色 · 简洁专业；主流桌面工具结构；本稿覆盖**主界面（拖拽区 + 任务队列）**；一套精修。
- 覆盖状态：排队中 / 转写中（进度+实时倍率+剩余）/ 已完成 / 失败（重试）。
- 已完成行操作：**复制全文 · 展开预览 · 打开目录 · 移除**；点击「展开预览」在该行下方展开转写结果预览（可滚动、再次点击收起）。
- 关键交互：拖拽/选择文件入队、「开始全部」、复制全文（写剪贴板）、展开/收起结果预览、移除、清空已完成。
- 支持格式（25 种）：M4A/MP4/MOV/M4V/WAV/MP3/AAC/FLAC/OGG/OPUS/AMR/WMA/AIFF/MKV/WEBM/AVI/FLV/WMV/3GP/TS/M2TS/RMVB/MPEG/ASF/DV。
- 布局：右侧「状态 + 操作」放进同一弹性区（状态左对齐、操作右对齐）；转写中的进度条自动拉长到接近右侧「移除」按钮；列表用 `scrollbar-gutter: stable` 预留滚动条空间，展开/收起预览时宽度不跳动；窗口最小宽度 1024px，窄屏走响应式（侧栏收窄、右区收窄），不重叠。
- 说明：早期「转写中实时预览」方案**不纳入正式功能**（已从设计集移除），正式版只保留"已完成 → 展开预览"。
- 状态：**approved（已评审通过）**；M2 已按此稿实现于 `app/`（Electron）。


