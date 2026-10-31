# AudioText Desktop · 音视频转文字桌面工具

> 本地离线把音视频转成可复制文字的桌面应用。用户一键复制文本，粘贴到网页端 AI 做归纳总结。

## 做什么 / 不做什么
- **做**：音视频 → 文字（可带/不带时间戳）；批量、进度、断点；可选术语校正；输出 `txt / srt / md / json`。
- **不做（一期）**：内置 AI 总结/问答、云端账号与计费、说话人分离、翻译、视频编辑。
- 总结交给用户复制到外部网页 AI。产品范围以 [docs/PRD.md](docs/PRD.md) 为唯一权威。

## 关键特性
- 纯本地推理，运行期不联网、不上传音视频。
- **一个安装包 + 可选模型**：装完即用，运行期不下载。
- 有独显走 GPU（快、准），无独显自动回落 CPU。

## 交付形态
- Windows 10/11 x64，安装包（Inno Setup / NSIS）。
- 可选组件：`small`（基础）/ `medium` / `large-v3` / `CUDA 运行库`。

## 下载
- 安装包：到 [Releases](https://github.com/Astyyym/audiotext-desktop/releases) 下载最新 `AudioTextDesktop-Setup-<版本>.exe`（内置 CUDA 运行库 + `small` 模型，装完即用；未签名，安装时按「更多信息 → 仍要运行」）。
- 安装与使用说明见 [INSTALL.md](INSTALL.md)。

## 模型下载（可选，大模型不入库）
`small` 已随安装包内置；`medium` / `large-v3` 体积大（模型包约 3.97GB），不放进仓库。请从下列来源下载对应模型目录，放到安装目录 `resources/models/` 下，重启后在「设置/顶栏 → 模型」选择：
- 魔搭 ModelScope（推荐，国内快）：
  - https://modelscope.cn/models/Systran/faster-whisper-medium
  - https://modelscope.cn/models/Systran/faster-whisper-large-v3
- HuggingFace（同名 `Systran/faster-whisper-*`，国内访问不稳）：
  - https://huggingface.co/Systran/faster-whisper-medium
  - https://huggingface.co/Systran/faster-whisper-large-v3

> 模型为 faster-whisper 的 CTranslate2 转换版，版权归原作者；本项目只做本地推理封装。

## 许可
本项目代码以 MIT 许可发布（见 [LICENSE](LICENSE)）；第三方组件（faster-whisper / CTranslate2 / ffmpeg 等）遵循各自许可。

## 文档导航
| 类别 | 文件 | 说明 |
|---|---|---|
| 产品需求（权威） | [docs/PRD.md](docs/PRD.md) | 范围、非目标、验收、已确认决策 |
| 技术设计 | [docs/design.md](docs/design.md) | 架构、选型、输出格式、打包方案 |
| 前端壳 | [app/README.md](app/README.md) | Electron 主界面：运行、配置、架构 |
| 转写引擎 | [engine/README.md](engine/README.md) | CLI 引擎：依赖、运行、进度事件 |
## 状态
- 当前版本 **v0.3.2**：GPU（CUDA）加速 + `small / medium / large-v3` 可选模型 + 设置 / 历史 / 术语库页面。
- 安装包与使用说明见 [INSTALL.md](INSTALL.md)；大模型从 [模型下载](#模型下载可选大模型不入库) 获取。

## 从源码运行 / 构建
- 引擎：`python -m engine.cli transcribe --input <文件> --out <目录> --lang zh --device auto --model <模型目录> --formats txt,srt --progress-json`（依赖见 [engine/README.md](engine/README.md)）。
- 前端壳：`cd app && npm install && npm start`（本机需先清除 `ELECTRON_RUN_AS_NODE`）。
- 打包：`scripts/build-engine.ps1` → `scripts/fetch-ffmpeg.ps1` → `scripts/build-app.ps1`（产物在 `release/`）。
