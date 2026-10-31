"""Build and verify the offline three-model ZIP64 bundle (Python stdlib only).

Usage: python scripts/package-models.py [--models models] [--output release/...zip]
Existing output is preserved; choose a new output name to rebuild.
"""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

FILES = {
    "small": ["config.json", "tokenizer.json", "vocabulary.txt", "model.bin"],
    "medium": ["config.json", "tokenizer.json", "vocabulary.txt", "model.bin"],
    "large-v3": ["config.json", "tokenizer.json", "vocabulary.json", "preprocessor_config.json", "model.bin"],
}
MODEL_SIZES = {"small": 483546902, "medium": 1527906378, "large-v3": 3087284237}
README = """AudioText Desktop 离线模型包（small / medium / large-v3）

1. 安装 AudioTextDesktop-Setup-0.4.0.exe。
2. 在应用「设置 → 模型下载」点击「打开模型目录」。
3. 把本压缩包中的 small、medium、large-v3 三个文件夹整体解压/复制进去。
   最终层级：<安装目录>\\resources\\models\\small\\model.bin
             <安装目录>\\resources\\models\\medium\\model.bin
             <安装目录>\\resources\\models\\large-v3\\model.bin
   不要在 models 里再套一层同名压缩包目录。
4. 回到应用点击「刷新模型列表」或重启应用，在顶栏/设置选择模型。
   CPU 建议 small；GPU 可选 medium（均衡）或 large-v3（质量优先）。
5. 准备好模型后可断网转写；音视频始终只在本机处理。

本包仅包含 faster-whisper 的 CTranslate2 格式模型，不含本机缓存/日志。
SHA256SUMS.txt 可用于核对解压后的文件。
来源：https://modelscope.cn/models/Systran/faster-whisper-small
      https://modelscope.cn/models/Systran/faster-whisper-medium
      https://modelscope.cn/models/Systran/faster-whisper-large-v3
模型由 OpenAI Whisper 转换而来，遵循 MIT 许可，详情见 MODEL-LICENSE.txt。
"""
MODEL_LICENSE = """Whisper / faster-whisper models

MIT License

Copyright (c) 2022 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the \"Software\"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Source license: https://github.com/openai/whisper/blob/main/LICENSE
Converted models: https://github.com/SYSTRAN/faster-whisper
"""


def digest(stream):
    h = hashlib.sha256()
    for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
        h.update(chunk)
    return h.hexdigest()


def main():
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", type=Path, default=root / "models")
    parser.add_argument("--output", type=Path, default=root / "release/AudioTextDesktop-models-small-medium-largev3.zip")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Output already exists; preserve it and select another --output.")
    entries = []
    for key, names in FILES.items():
        for name in names:
            src = args.models / key / name
            if not src.is_file() or not src.stat().st_size:
                parser.error(f"Missing or empty model file: {key}/{name}")
            if name == "model.bin" and src.stat().st_size != MODEL_SIZES[key]:
                parser.error(f"Unexpected model.bin size: {key}")
            entries.append((src, f"{key}/{name}"))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    hashes = {}
    with zipfile.ZipFile(args.output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as archive:
        for src, arcname in entries:
            print(f"Packing {arcname} ({src.stat().st_size} bytes)", flush=True)
            h = hashlib.sha256()
            with src.open("rb") as source, archive.open(arcname, "w", force_zip64=True) as target:
                for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
                    h.update(chunk)
                    target.write(chunk)
            hashes[arcname] = h.hexdigest()
        archive.writestr("README-模型导入.txt", README.encode("utf-8-sig"))
        archive.writestr("MODEL-LICENSE.txt", MODEL_LICENSE)
        archive.writestr("SHA256SUMS.txt", "".join(f"{h}  {name}\n" for name, h in hashes.items()))
    print("Verifying every archived file against source SHA256...", flush=True)
    with zipfile.ZipFile(args.output) as archive:
        for name, expected in hashes.items():
            with archive.open(name) as source:
                actual = digest(source)
            if actual != expected:
                raise RuntimeError(f"Archive verification failed: {name}")
    with args.output.open("rb") as source:
        zip_hash = digest(source)
    sidecar = args.output.with_suffix(args.output.suffix + ".sha256")
    sidecar.write_text(f"{zip_hash}  {args.output.name}\n", encoding="utf-8")
    print(json.dumps({"status": "passed", "archive": args.output.name, "bytes": args.output.stat().st_size, "files_verified": len(hashes), "sha256": zip_hash}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
