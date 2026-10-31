# 02 · 环境与技术边界

- 语言/运行时：Python 3.11.x（ctranslate2 轮子兼容性好），独立 venv。
- 本机引擎 venv：Hermes 的 `faster-whisper` venv（Python 3.11，faster-whisper 1.2.1 / ctranslate2 4.8.4）。ffmpeg 8.1-full（Gyan）在 PATH。
- 前端壳：Electron 40.9.3（`app/`）；Node 24 / npm 11。二进制命中 `%LOCALAPPDATA%\electron\Cache`。
- 引擎依赖（实测）：faster-whisper 1.2.1、ctranslate2 4.8.4、av 18.1.0、onnxruntime 1.31.1、numpy 2.4.6、tokenizers 0.23.3。
- 模型：CTranslate2 格式 Whisper；small / medium / large-v3 本地均已准备，分别约 461MB / 1457MB / 2944MB（model.bin）。完整目录可直接由 faster-whisper 加载。
- 音视频：ffmpeg/ffprobe 静态二进制；抽 16k 单声道 wav。
- GPU：ctranslate2 自带 cudnn64_9；还需 cublas/cublasLt，可复用本机已装 torch 的 `lib` 目录（开发设 `ATD_CUDA_DIR`），发布时内置到 `cuda/`。用户只需 NVIDIA 驱动。small GPU 实测 9–13× 实时。
- 性能基线：RTX 4060 Laptop 8G + large-v3/float16 ≈19× 实时（large-v3 需另行准备）。
- 打包边界：**不要单文件 exe**（启动解压 3G 慢）；用安装包 one-folder + 可选模型组件；ffmpeg 用 LGPL 构建。
- 打包链：`engine/` 用 PyInstaller onedir 成 `engine.exe`（含 VAD 资产，~245MB）；`app/` 用 electron-builder 26.18 → NSIS；`extraResources` 仅带 `engine/ bin/ cuda/`。
- 当前交付：v0.4 不含模型，CUDA 随包；small / medium / large-v3 可应用内主动从魔搭下载或离线导入。未签名、无自动更新，多机型内测尚待开展。
- 模型离线包通过 `scripts/package-models.py` 生成 ZIP64，顶层三个模型目录，排除缓存并验证 SHA256。旧版本体积与证据见 progress，不作为现行分发规则。

详细证据与踩坑保存在维护者本地的 `docs/internal/findings.md`，不随公开仓库分发。
