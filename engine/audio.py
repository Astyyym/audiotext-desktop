# -*- coding: utf-8 -*-
"""音视频处理：ffmpeg 读取时长、抽 16k 单声道 wav（不再依赖 ffprobe，减小安装体积）。"""
import os
import re
import shutil
import subprocess
import tempfile


def _bin(name: str) -> str:
    """优先用环境变量（FFMPEG / FFPROBE），否则用 PATH。"""
    env = os.environ.get(name.upper())
    if env and os.path.exists(env):
        return env
    found = shutil.which(name)
    if not found:
        raise FileNotFoundError(f"找不到 {name}，请安装 ffmpeg 或设置环境变量 {name.upper()}")
    return found


def probe_duration(path: str) -> float:
    """用 `ffmpeg -i` 的 stderr 解析时长；不依赖 ffprobe（两者功能重复，已移除以减小体积）。"""
    exe = _bin("ffmpeg")
    r = subprocess.run([exe, "-i", path], capture_output=True, text=True, errors="ignore")
    text = (r.stderr or "") + (r.stdout or "")
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if not m:
        return 0.0
    hours, minutes, seconds = int(m.group(1)), int(m.group(2)), float(m.group(3))
    return hours * 3600 + minutes * 60 + seconds


def to_wav16k(src: str, dst: str = None) -> str:
    """抽音轨为 16k 单声道 wav，返回 wav 路径（临时文件由调用方清理）。"""
    exe = _bin("ffmpeg")
    if dst is None:
        fd, dst = tempfile.mkstemp(suffix=".wav", prefix="atd_")
        os.close(fd)
    subprocess.run(
        [exe, "-y", "-v", "error", "-i", src, "-vn",
         "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dst],
        check=True)
    return dst
