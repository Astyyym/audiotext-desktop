# -*- coding: utf-8 -*-
"""设备与计算精度选择，以及 Windows 下 CUDA 运行库 DLL 的加载。

发布版：CUDA DLL 随安装包放在 `cuda/` 目录，通过环境变量 ATD_CUDA_DIR 指定。
开发版：可指向已有 torch 的 lib 目录复用 cublas/cudnn，免装 nvidia wheel。
"""
import os
import sys


def setup_cuda_dlls() -> None:
    """把 ATD_CUDA_DIR（或已安装的 nvidia 包 bin）加入 DLL 搜索路径。"""
    candidates = []
    env = os.environ.get("ATD_CUDA_DIR")
    if env:
        candidates.append(env)
    # pip 安装的 nvidia-*-cu12 包
    sp = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")
    if os.path.isdir(sp):
        for name in os.listdir(sp):
            b = os.path.join(sp, name, "bin")
            if os.path.isdir(b):
                candidates.append(b)

    for d in candidates:
        if not os.path.isdir(d):
            continue
        try:
            os.add_dll_directory(d)  # Python 3.8+
        except Exception:
            pass
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def pick_device(prefer: str = "auto"):
    """返回 (device, compute_type)。auto：有可用 CUDA 用 GPU，否则 CPU。"""
    if prefer == "cpu":
        return "cpu", "int8"
    if prefer in ("cuda", "gpu"):
        return "cuda", "float16"

    # auto
    setup_cuda_dlls()
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"
