# 03 · 高频踩坑

1. **PyPI 官方源慢** → 用清华镜像 `--index-url https://pypi.tuna.tsinghua.edu.cn/simple`，装得更快。
2. **CUDA 库缺失** → 不必装 1.3G nvidia wheel，复用 torch/lib 的 `cublas64_12`/`cudnn64_9`（发布时内置 DLL）。
3. **Windows 中文乱码** → 写文件 `encoding="utf-8"`；子进程设 `PYTHONIOENCODING=utf-8`。
4. **段落碎** → 合并参数用 间隔≤5s 且 ≤240 字，别用 2.5s/110。
5. **单文件 exe 启动慢/误报** → 用安装包 one-folder，不用 PyInstaller onefile。
6. **离线要求** → 转写必须用完整的本地模型目录；仅用户主动点击模型下载时允许从魔搭联网取模型，不上传音视频。
7. **ffmpeg 许可** → 商用分发用 LGPL 构建。
8. **LibreOffice Kit 转 PDF** → 输出文件已存在会 `EEXIST`，先删旧再转（仅文档生成功能涉及）。
9. **ELECTRON_RUN_AS_NODE=1（本机全局）** → 直接跑 `electron.exe` 会变成纯 Node、不开窗口；启动 GUI 前必须清除该环境变量。
10. **拖拽文件路径** → Electron 32+ 无 `File.path`，须用 preload 的 `webUtils.getPathForFile`。
11. **模型不全** → 三种模型均已在本地准备；仍需验证必要文件完整，不能仅凭 model.bin 存在判断安装成功。

详细历史证据保存在维护者本地的 `docs/internal/findings.md`，不随公开仓库分发。
