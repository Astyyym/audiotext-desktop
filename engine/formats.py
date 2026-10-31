# -*- coding: utf-8 -*-
"""输出格式：txt（纯文本段落）/ srt（字幕）/ md（带时间戳）/ json（结构化）。"""
import json
import re

# whisper 在静音/片头常见的训练数据幻觉，直接丢弃
HALLUCINATION = [
    "请不吝点赞", "订阅转发", "打赏支持", "明镜与点点", "字幕由",
    "Amara.org", "字幕志愿者", "谢谢观看", "感谢观看", "本字幕由", "中文字幕由",
]
_FILLER = {"嗯", "呃", "啊", "哦", "唉"}


def is_hallucination(text: str) -> bool:
    t2 = re.sub(r"[\s,，。.、]", "", text or "")
    if not t2:
        return True
    if t2 in _FILLER:
        return True
    return any(re.sub(r"[\s,，。.、]", "", h) in t2 for h in HALLUCINATION)


def _fmt_mmss(sec: float) -> str:
    sec = max(0, int(sec))
    h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def _fmt_srt(sec: float) -> str:
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def merge_paragraphs(segments, max_gap: float = 5.0, max_len: int = 240):
    """把碎句合并成段落：相邻间隔≤max_gap 且合并后≤max_len 字。"""
    out = []
    cur_start = cur_end = None
    cur = []
    for seg in segments:
        text = (seg["text"] if isinstance(seg, dict) else seg.text).strip()
        if not text:
            continue
        st = seg["start"] if isinstance(seg, dict) else seg.start
        ed = seg["end"] if isinstance(seg, dict) else seg.end
        if cur_start is None:
            cur_start, cur_end, cur = st, ed, [text]
            continue
        if st - cur_end <= max_gap and sum(len(x) for x in cur) + len(text) <= max_len:
            cur.append(text)
            cur_end = ed
        else:
            out.append((cur_start, "".join(cur)))
            cur_start, cur_end, cur = st, ed, [text]
    if cur:
        out.append((cur_start, "".join(cur)))
    return out


def write_txt(segments, path: str, with_bom: bool = True) -> None:
    paras = merge_paragraphs(segments)
    body = "\n\n".join(t for _, t in paras) + "\n"
    with open(path, "w", encoding="utf-8-sig" if with_bom else "utf-8") as f:
        f.write(body)


def write_md(segments, path: str) -> None:
    paras = merge_paragraphs(segments)
    body = "\n\n".join(f"**[{_fmt_mmss(s)}]** {t}" for s, t in paras) + "\n"
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)


def write_srt(segments, path: str) -> None:
    lines = []
    idx = 0
    for seg in segments:
        text = (seg["text"] if isinstance(seg, dict) else seg.text).strip()
        if not text:
            continue
        st = seg["start"] if isinstance(seg, dict) else seg.start
        ed = seg["end"] if isinstance(seg, dict) else seg.end
        idx += 1
        lines.append(str(idx))
        lines.append(f"{_fmt_srt(st)} --> {_fmt_srt(ed)}")
        lines.append(text)
        lines.append("")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def write_json(segments, meta: dict, path: str) -> None:
    segs = []
    for seg in segments:
        if isinstance(seg, dict):
            segs.append({"start": round(seg["start"], 2), "end": round(seg["end"], 2), "text": seg["text"]})
        else:
            segs.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text})
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "segments": segs}, f, ensure_ascii=False, indent=2)
