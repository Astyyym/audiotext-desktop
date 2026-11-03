# AGENTS.md — 项目长期指令

本文件是长期规则与边界，每次进入项目工作前应先读。产品范围见 `docs/PRD.md`。

## 1. 项目定位
AudioText Desktop：本地离线音视频转文字桌面应用。目标平台 Windows 10/11 x64。范围、非目标、验收见 `docs/PRD.md`。

## 2. 权威顺序（冲突时按此裁决，并同步派生记录）
1. 产品范围与验收：`docs/PRD.md`
2. 长期规则与交付约束：本文件 `AGENTS.md`
3. 技术设计与输出规范：`docs/design.md`（须在 PRD 范围内）
4. 本次实施步骤与验证：`docs/internal/plan.md`
5. 当前阶段状态：`docs/internal/task-state.md`
6. 证据与历史：`docs/internal/findings.md`、`docs/internal/progress.md`（只记录证据，不覆盖规范）

> 同一决策只在一处作为权威，其余位置用链接引用，禁止在多份规范文档里重复定义。

## 3. 文档分工
| 文档 | 责任 |
|---|---|
| `README.md` | 产品面向：是什么、能力、交付形态、文档导航 |
| `docs/PRD.md` | 需求：范围、非目标、功能/非功能需求、验收、已确认决策 |
| `docs/design.md` | 技术设计：架构、选型、设备/模型策略、输出格式、打包方案 |
| `docs/internal/plan.md` | 本次改动的短计划：精确文件、步骤、验收、停止条件、风险 |
| `docs/internal/task-state.md` | 当前阶段、阻塞、验收状态、下一道门 |
| `docs/internal/findings.md` | 环境结论、踩坑、失败方案（带证据） |
| `docs/internal/progress.md` | 简洁的会话历史（标为 history，不作现行指令） |
| `memory/` | 每次到访需知的稳定项目事实、环境边界、坑（入口 `memory/README.md`） |

## 4. 目录约定
- `docs/`：产品与设计文档（可公开）。
- `docs/internal/`：内部工作记录（plan/task-state/findings/progress），仅维护者本地保留并由 `.gitignore` 排除；公开克隆没有这些文件，协作者按本地需要建立。
- 截图和安装验收使用系统临时目录及隔离配置，结束后关闭并清理；项目目录不作为日常安装位置，正式安装路径由用户选择。
- `memory/`：项目记忆，随仓库提交，遵守敏感数据规则。
- 已建：`app/`（Electron 前端壳）、`engine/`（Python sidecar）、`scripts/`（构建/打包脚本）。
- 本地构建产物（gitignore，不入库）：`bin/`（ffmpeg）、`models/`（模型）、`build/`（PyInstaller 中间/产物）、`release/`（安装包）。
- 禁止提交大文件：模型、ffmpeg/二进制、CUDA DLL、构建产物（见 `.gitignore`）。

## 5. 交付约束（所有改动都必须满足）
- **离线**：转写在本地完成、不上传音视频；仅用户主动点击模型下载时联网。
- **安装**：基础安装包含引擎、ffmpeg（默认 CPU，**不内置 CUDA**）；GPU 加速包（CUDA 运行库）为可选组件，按需下载或离线导入；small/medium/large-v3 全部独立分发，支持模型页从魔搭下载或离线导入（产品验收见 `docs/PRD.md`）。
- **引擎**：`faster-whisper` + `CTranslate2`；`device=auto`（有 GPU 用 GPU，否则 CPU）。
- **许可**：ffmpeg 商用分发使用 **LGPL** 构建（避免 GPL 传染）。
- **发布前扫描**：密钥、个人/客户数据、本机绝对路径、日志、数据库、缓存、构建产物。

## 6. 工作纪律
- 分档执行：`micro fix` / `feature` / `migration-release-high-risk`。
- 本项目**打包与分发按高风险档**处理（涉及安装器、GPU/驱动差异、合规许可）。
- 每个改动：记录需求与验收 → 写短计划（精确文件/步骤/验收/停止条件/风险）→ 分阶段实现 → 用**真实行为**验证 → 分别报告 `passed / failed / blocked / deferred`。
- 语法通过、进程启动、文件生成、`git push` 都不等于"行为通过 / 已发布"。

## 7. 项目专属技能

本项目的项目级技能放在 `skills/<name>/`，开始相关任务前先读其 `SKILL.md`（及按需的 `references/`）。项目技能只属于本项目，不加入 Hermes 全局技能目录。

| 技能 | 入口 | 适用任务 |
|---|---|---|
| `audio-video-transcribe` | `skills/audio-video-transcribe/SKILL.md` | 本地音视频 → 文字/字幕：ffprobe+ffmpeg 预处理、faster-whisper 带时间戳转写（GPU/CPU 自动）、幻觉过滤、段落合并、可选术语校正、导出 txt/srt/md；参考脚本 `skills/audio-video-transcribe/scripts/transcribe.py` |

## 8. 常用命令
```bash
git status
git log --oneline -5
git add -A && git commit -m "<type>: <summary>"
```

引擎（在 `Desktop/` 根目录）：
```bash
python -m engine.cli transcribe --input <f> --out <dir> --lang zh --device auto --model <模型目录> --formats txt,srt --progress-json
```

前端壳（在 `app/`）：
```bash
npm install       # 首次
npm start         # 启动 Electron（本机需先清除 ELECTRON_RUN_AS_NODE）
```
运行配置放 `app/config.local.json`（gitignore），模板见 `app/config.local.example.json`。

打包（在 `Desktop/`，产物在 `release/`）：
```powershell
& scripts/build-engine.ps1 -Python <装了faster-whisper+pyinstaller的解释器>   # -> build/engine-dist/engine/engine.exe
& scripts/fetch-ffmpeg.ps1                                                 # -> bin/ffmpeg.exe (LGPL)
& scripts/build-app.ps1            # 未压缩目录 -> release/win-unpacked
& scripts/build-app.ps1 -Target nsis   # 基础安装包 -> release/AudioTextDesktop-Setup-<ver>.exe
& scripts/build-gpu-pack.ps1       # 可选 GPU 加速包 -> release/AudioTextDesktop-GPU-cu12-<tag>.zip（并更新 app/gpu-pack.json）
```
前置：engine、ffmpeg 就位；GPU 加速包由 build-gpu-pack.ps1 单独产出、不随基础安装包；构建安装包不要求模型。离线模型包仅从本地三种完整模型生成（模型不入库，见 `.gitignore`）。
