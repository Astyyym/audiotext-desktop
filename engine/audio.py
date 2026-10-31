# -*- coding: utf-8 -*-
"""音视频处理：ffprobe 取时长、ffmpeg 抽 16k 单声道 wav。"""
import os
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
    exe = _bin("ffprobe")
    r = subprocess.run(
        [exe, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except Exception:
        return 0.0


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
