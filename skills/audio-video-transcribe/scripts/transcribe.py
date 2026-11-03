#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""audio-video-transcribe 参考实现：音视频 → txt / srt / md。

用法：
  python transcribe.py --input <音视频> --out <输出目录> --model <模型目录> \
      [--lang zh] [--device auto|cuda|cpu] [--formats txt,srt,md]
环境变量：ATD_MODEL / ATD_CUDA_DIR / FFMPEG / FFPROBE
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HALLUCINATION = [
    "请不吝点赞", "订阅转发", "打赏支持", "明镜与点点", "字幕由",
    "Amara.org", "字幕志愿者", "谢谢观看", "感谢观看", "本字幕由", "中文字幕由",
]
FILLER = {"嗯", "呃", "啊", "哦", "唉"}


def setup_cuda_dlls():
    cands = []
    env = os.environ.get("ATD_CUDA_DIR")
    if env:
        cands.append(env)
    sp = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")
    if os.path.isdir(sp):
        for n in os.listdir(sp):
            b = os.path.join(sp, n, "bin")
            if os.path.isdir(b):
                cands.append(b)
    for d in cands:
        if not os.path.isdir(d):
            continue
        try:
            os.add_dll_directory(d)
        except Exception:
            pass
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def bin_path(name):
    env = os.environ.get(name.upper())
    if env and os.path.exists(env):
        return env
    found = shutil.which(name)
    if not found:
        raise FileNotFoundError(f"找不到 {name}，请安装 ffmpeg 或设置环境变量 {name.upper()}")
    return found


def probe_duration(path):
    exe = bin_path("ffprobe")
    r = subprocess.run([exe, "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=nw=1:nk=1", path], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def to_wav16k(src):
    exe = bin_path("ffmpeg")
    fd, dst = tempfile.mkstemp(suffix=".wav", prefix="atd_")
    os.close(fd)
    subprocess.run([exe, "-y", "-v", "error", "-i", src, "-vn",
                    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dst], check=True)
    return dst


def is_hallucination(text):
    t2 = re.sub(r"[\s,，。.、]", "", text or "")
    if not t2 or t2 in FILLER:
        return True
    return any(re.sub(r"[\s,，。.、]", "", h) in t2 for h in HALLUCINATION)


def fmt_mmss(sec):
    sec = max(0, int(sec))
    h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def fmt_srt(sec):
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def merge(segments, gap=5.0, max_len=240):
    out, cur_start, cur_end, cur = [], None, None, []
    for seg in segments:
        if cur_start is None:
            cur_start, cur_end, cur = seg["start"], seg["end"], [seg["text"]]
            continue
        if seg["start"] - cur_end <= gap and sum(len(x) for x in cur) + len(seg["text"]) <= max_len:
            cur.append(seg["text"]); cur_end = seg["end"]
        else:
            out.append((cur_start, "".join(cur))); cur_start, cur_end, cur = seg["start"], seg["end"], [seg["text"]]
    if cur:
        out.append((cur_start, "".join(cur)))
    return out


def write_txt(segments, path):
    with open(path, "w", encoding="utf-8-sig") as f:
        f.write("\n\n".join(t for _, t in merge(segments)) + "\n")


def write_md(segments, path):
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n\n".join(f"**[{fmt_mmss(s)}]** {t}" for s, t in merge(segments)) + "\n")


def write_srt(segments, path):
    lines, idx = [], 0
    for seg in segments:
        idx += 1
        lines += [str(idx), f"{fmt_srt(seg['start'])} --> {fmt_srt(seg['end'])}", seg["text"], ""]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def pick_device(prefer):
    if prefer == "cpu":
        return "cpu", "int8"
    if prefer in ("cuda", "gpu"):
        return "cuda", "float16"
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


def main():
    ap = argparse.ArgumentParser(description="音视频 → txt/srt/md（faster-whisper）")
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", default=".")
    ap.add_argument("--model", default=os.environ.get("ATD_MODEL"))
    ap.add_argument("--lang", default="zh", help="zh / en / auto")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--formats", default="txt,srt,md")
    ap.add_argument("--prompt", default="以下是普通话对话。")
    ap.add_argument("--beam", type=int, default=5)
    ap.add_argument("--gap", type=float, default=5.0)
    ap.add_argument("--max-len", type=int, default=240)
    args = ap.parse_args()

    if not os.path.isfile(args.input):
        sys.exit(f"输入不存在：{args.input}")
    if not args.model or not os.path.isdir(args.model):
        sys.exit("模型目录不存在，请用 --model 或 ATD_MODEL 指定")

    setup_cuda_dlls()
    from faster_whisper import WhisperModel

    t0 = time.time()
    device, ctype = pick_device(args.device)
    model = WhisperModel(args.model, device=device, compute_type=ctype)
    dur = probe_duration(args.input)
    wav = to_wav16k(args.input)
    segments = []
    try:
        seg_iter, info = model.transcribe(
            wav, language=None if args.lang == "auto" else args.lang,
            vad_filter=True, vad_parameters=dict(min_silence_duration_ms=400),
            beam_size=args.beam, condition_on_previous_text=False,
            initial_prompt=args.prompt)
        for seg in seg_iter:
            text = (seg.text or "").strip()
            if not text or is_hallucination(text):
                continue
            segments.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": text})
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass

    os.makedirs(args.out, exist_ok=True)
    stem = os.path.splitext(os.path.basename(args.input))[0]
    fmts = {x.strip().lower() for x in args.formats.split(",") if x.strip()}
    outs = []
    if "txt" in fmts:
        p = os.path.join(args.out, stem + ".txt"); write_txt(segments, p); outs.append(p)
    if "srt" in fmts:
        p = os.path.join(args.out, stem + ".srt"); write_srt(segments, p); outs.append(p)
    if "md" in fmts:
        p = os.path.join(args.out, stem + ".md"); write_md(segments, p); outs.append(p)

    elapsed = time.time() - t0
    print(f"device={device}/{ctype}  duration={dur:.1f}s  segments={len(segments)}  "
          f"elapsed={elapsed:.1f}s  speed={dur/max(elapsed,0.1):.1f}x")
    for p in outs:
        print(" ->", p)


if __name__ == "__main__":
    main()
