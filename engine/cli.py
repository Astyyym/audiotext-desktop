# -*- coding: utf-8 -*-
"""命令行入口：音视频 → txt / srt / md / json，带 JSON 行进度事件。

用法（在项目根 Desktop/ 下）：
  python -m engine.cli transcribe --input <音视频> --out <输出目录> \
      --lang zh --device auto --model <模型目录> --formats txt,srt --progress-json

环境变量：
  ATD_MODEL      默认模型目录（--model 未给时使用）
  ATD_CUDA_DIR   发布版 CUDA DLL 目录（GPU 时需要）
  FFMPEG/FFPROBE 自定义可执行路径（默认用 PATH）
"""
import argparse
import json
import os
import sys
import time

# 支持 `python engine/cli.py` 与 `python -m engine.cli` 两种运行方式
if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import audio, formats, transcribe  # noqa: E402
from engine.device import pick_device  # noqa: E402

DEFAULT_PROMPT = "以下是普通话对话。"


def _load_terms(path):
    """读取术语表 JSON：{"terms": ["术语1", ...], "replace": {"误写": "正写"}} 或纯数组。"""
    if not path:
        return [], {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return [], {}
    if isinstance(data, list):
        return [str(x) for x in data if str(x).strip()], {}
    terms = [str(x) for x in (data.get("terms") or []) if str(x).strip()]
    rep = data.get("replace") or {}
    if isinstance(rep, dict):
        rep = {str(k): str(v) for k, v in rep.items() if str(k)}
    else:
        rep = {}
    return terms, rep


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _discard_outputs(paths):
    for path in paths:
        try:
            os.remove(path)
        except OSError:
            pass


def _reserve_outputs(out_dir, stem, fmts):
    """Reserve a fresh, shared stem without replacing any existing output."""
    supported = ("txt", "srt", "md", "json")
    requested = [fmt for fmt in supported if fmt in fmts]
    if not requested:
        return {}
    number = 0
    while True:
        name = stem if number == 0 else f"{stem} ({number})"
        # Keep existing output groups together, including formats not requested now.
        if any(os.path.lexists(os.path.join(out_dir, name + "." + fmt)) for fmt in supported):
            number += 1
            continue
        outputs = {fmt: os.path.join(out_dir, name + "." + fmt) for fmt in requested}
        reserved = []
        try:
            for path in outputs.values():
                # Exclusive creation also protects against another process racing us.
                with open(path, "x", encoding="utf-8"):
                    pass
                reserved.append(path)
            return outputs
        except BaseException as exc:
            _discard_outputs(reserved)
            if not isinstance(exc, FileExistsError):
                raise
            number += 1


def cmd_transcribe(args) -> int:
    model_dir = args.model or os.environ.get("ATD_MODEL")
    if not model_dir or not os.path.isdir(model_dir):
        _emit({"type": "error", "message": "模型目录不存在，请用 --model 或 ATD_MODEL 指定"})
        return 2

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    fmts = [x.strip().lower() for x in args.formats.split(",") if x.strip()]

    terms, replace_map = _load_terms(getattr(args, "terms", None))
    prompt = args.prompt or DEFAULT_PROMPT
    if terms:
        prompt = prompt.rstrip("。") + "。可能出现的术语：" + "、".join(terms) + "。"

    t0 = time.time()
    device, ctype = pick_device(args.device)
    _emit({"type": "status", "stage": "device", "device": device, "compute_type": ctype})

    _emit({"type": "status", "stage": "model_load", "model": model_dir})
    tm = time.time()
    model = transcribe.load_model(model_dir, device=device, compute_type=ctype)
    load_s = time.time() - tm

    dur = audio.probe_duration(args.input)
    wav = audio.to_wav16k(args.input)
    _emit({"type": "status", "stage": "transcribing", "duration": round(dur, 1),
           "model_load_s": round(load_s, 1)})

    language = None if args.lang in ("", "auto") else args.lang
    segments = []
    chars = 0
    try:
        seg_iter, info = transcribe.iter_segments(
            model, wav, language=language, initial_prompt=prompt, beam_size=args.beam)
        for seg in seg_iter:
            text = seg.text or ""
            if replace_map:
                for _k, _v in replace_map.items():
                    text = text.replace(_k, _v)
            text = text.strip()
            if not text or formats.is_hallucination(text):
                continue
            item = {"start": round(seg.start, 2), "end": round(seg.end, 2), "text": text}
            segments.append(item)
            chars += len(text)
            if args.progress_json:
                prog = round(min(100.0, (seg.end / dur * 100) if dur else 0), 1)
                _emit({"type": "segment", **item, "progress": prog})
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass

    stem = os.path.splitext(os.path.basename(args.input))[0]
    outputs = _reserve_outputs(out_dir, stem, fmts)
    try:
        for fmt, writer in (("txt", formats.write_txt), ("srt", formats.write_srt), ("md", formats.write_md)):
            if fmt in outputs:
                writer(segments, outputs[fmt])
        if "json" in outputs:
            meta = {
                "source": os.path.abspath(args.input),
                "duration_sec": round(dur, 1),
                "language": info.language,
                "language_probability": round(getattr(info, "language_probability", 0.0), 3),
                "model": os.path.basename(model_dir.rstrip("/\\")),
                "device": device,
                "compute_type": ctype,
                "elapsed_sec": round(time.time() - t0, 1),
                "speed_x": round(dur / max(time.time() - t0, 0.1), 1),
                "chars": chars,
                "segments": len(segments),
            }
            formats.write_json(segments, meta, outputs["json"])
    except BaseException:
        _discard_outputs(outputs.values())
        raise

    elapsed = time.time() - t0
    _emit({"type": "done", "outputs": outputs, "segments": len(segments), "chars": chars,
           "elapsed_sec": round(elapsed, 1), "speed_x": round(dur / max(elapsed, 0.1), 1)})
    return 0


def cmd_probe(args) -> int:
    """探测 GPU 是否可用（供前端决定默认设备/模型）。"""
    from engine.device import setup_cuda_dlls, has_cublas
    setup_cuda_dlls()
    n = 0
    if has_cublas():
        try:
            import ctranslate2
            n = int(ctranslate2.get_cuda_device_count())
        except Exception:
            n = 0
    _emit({"type": "probe", "cuda": n > 0, "devices": n,
           "device": "cuda" if n > 0 else "cpu"})
    return 0


def build_parser():
    ap = argparse.ArgumentParser(prog="engine", description="AudioText Desktop 转写引擎")
    sub = ap.add_subparsers(dest="cmd", required=True)

    t = sub.add_parser("transcribe", help="把音视频转成文字")
    t.add_argument("--input", required=True, help="音视频文件路径")
    t.add_argument("--out", default=".", help="输出目录（默认当前目录）")
    t.add_argument("--lang", default="zh", help="语言：zh/en/auto（空=自动）")
    t.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"], help="设备")
    t.add_argument("--model", default=None, help="模型目录（默认取 ATD_MODEL）")
    t.add_argument("--formats", default="txt,srt", help="输出格式，逗号分隔：txt,srt,md,json")
    t.add_argument("--prompt", default=DEFAULT_PROMPT, help="场景提示词")
    t.add_argument("--beam", type=int, default=5, help="beam_size")
    t.add_argument("--terms", default=None, help="术语表 JSON 路径（{terms:[],replace:{}} 或数组）")
    t.add_argument("--progress-json", action="store_true", help="向 stdout 输出 JSON 行进度事件")
    t.set_defaults(func=cmd_transcribe)

    p = sub.add_parser("probe", help="探测 GPU 可用性（输出 {type:probe,cuda:bool}）")
    p.set_defaults(func=cmd_probe)
    return ap


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        _emit({"type": "error", "message": "已取消"})
        return 130
    except Exception as e:  # noqa: BLE001
        _emit({"type": "error", "message": f"{type(e).__name__}: {e}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
