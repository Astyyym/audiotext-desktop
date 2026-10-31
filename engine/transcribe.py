# -*- coding: utf-8 -*-
"""faster-whisper 模型加载与转写（生成器）。"""
from faster_whisper import WhisperModel

from .device import setup_cuda_dlls


def load_model(model_dir: str, device: str = "cuda", compute_type: str = "float16"):
    if device.startswith("cuda"):
        setup_cuda_dlls()
    return WhisperModel(model_dir, device=device, compute_type=compute_type)


def iter_segments(model, wav_path: str, language: str = "zh",
                  initial_prompt: str = "以下是普通话对话。",
                  beam_size: int = 5):
    """返回 (segments_generator, info)。segment 含 .start/.end/.text。"""
    return model.transcribe(
        wav_path,
        language=language or None,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=400),
        beam_size=beam_size,
        condition_on_previous_text=False,
        initial_prompt=initial_prompt,
    )
