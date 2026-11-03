# AudioText Desktop · 安装与使用说明（v0.5）

音视频在本机离线转成文字，不上传。仅主动点击模型下载或 GPU 加速包下载时联网。

## 一、安装与准备模型

1. 从 [Releases](https://github.com/Astyyym/audiotext-desktop/releases) 下载 `AudioTextDesktop-Setup-<ver>.exe`（**基础安装器**），按向导选择自己的可写安装目录。Release 还提供可选的 `AudioTextDesktop-GPU-cu12-<tag>.zip`（GPU 加速包）及各文件 SHA256 校验；不上传模型包。
2. 内测安装包未签名。Windows 提示未知发布者时，可点「更多信息 → 仍要运行」。
3. 基础安装包含引擎和 ffmpeg，**默认 CPU，不含 CUDA，也不含任何模型**。打开「设置 → 模型下载（按需）」，任选一种方式准备至少一个模型：
   - **在线**：在 small、medium、large-v3 对应行点击「下载」，默认从魔搭 ModelScope 下载。进度可见，支持取消后重试续传。
   - **离线**：拿到 `AudioTextDesktop-models-small-medium-largev3.zip`，点击「打开模型目录」，将压缩包中的模型文件夹整体放进去，再点「刷新模型列表」。也可重启识别。

正确目录层级：

```text
<安装目录>\resources\models\
  small\model.bin
  small\config.json
  small\tokenizer.json
  small\vocabulary.txt
  medium\...（同样包含完整模型文件）
  large-v3\...（包含 model.bin、config.json、tokenizer.json 等）
```

不要在 models 里面额外套一层压缩包名称目录。可仅解压需要的一个模型。压缩包中的说明和 SHA256 清单用于核对文件完整性。

设备、模型可在顶栏直接切换。自动设备有 NVIDIA 加速时用 GPU，否则 CPU。自动模型有 GPU 时依次优先 medium、large-v3、small；无 GPU 时依次优先 small、medium、large-v3。CPU 建议 small；GPU 可选 medium（均衡）或 large-v3（质量优先）。

> **可选 GPU 加速（NVIDIA 显卡）**：默认安装为 CPU 版。想用 GPU 提速时，打开「设置 → 硬件加速」，点「下载」获取 GPU 加速包（CUDA 12 运行库，约数百 MB，支持断点续传），或点「导入离线包」选择本地 `.7z` 离线包。安装后顶栏设备选「GPU」或「自动」即可。不装 GPU 包也能正常用 CPU 转写；「移除」可删除已安装的 GPU 包。

## 二、转写

1. 拖入音视频或点击选择文件，文件先进入待确认卡片区，可继续添加或移除。
2. 点击「开始全部」开始队列，查看进度与剩余时间。
3. 完成后可「复制全文」「展开预览」，或通过文件夹图标打开输出目录。
4. 默认输出在源文件同目录的 `文字稿/` 中，生成 TXT 和 SRT。

## 三、用网页 AI 总结

先复制转写全文，再在「设置 → AI 总结提示词」复制提示词，粘贴到自己选择的网页 AI。提示词可编辑、恢复默认；应用本身不调用在线 AI。

## 四、常见问题

- **还没有可用模型**：先下载或导入完整模型，再刷新模型列表。
- **下载失败**：检查网络与磁盘空间，再次点击「下载」可继续断点。模型目录需可写；若安装在受保护目录，请换到当前用户可写的安装位置。若明确提示某个最终文件已存在但不可用，请先将该文件移出模型目录备份，再重试；应用会保护现有文件。
- **转写慢**：CPU 建议 small，NVIDIA GPU 可在顶栏选择 GPU；大模型需要更多内存/显存。
- **音频解码失败**：检查文件完整性，或转换为 WAV/MP3 重试。
- **未知发布者**：内测版本未签名。

## 五、隐私与数据位置

- 转写只读取本地模型、在本机完成；音视频不上传。准备好模型后可断网使用。
- 设置、历史和术语默认保存在 `%APPDATA%\audiotext-desktop\`。
- 「设置 → 历史存储位置」可指定自定义位置；保存时把已有历史复制过去，不删除原件。
- 卸载：Windows「设置 → 应用 → AudioText Desktop → 卸载」，或使用安装目录中的卸载器。需要保留模型时，请先备份模型目录。
