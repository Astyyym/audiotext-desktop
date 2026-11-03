# -*- coding: utf-8 -*-
"""设备与计算精度选择，以及 Windows 下 CUDA 运行库 DLL 的加载。

发布版：CUDA DLL 随安装包放在 `cuda/` 目录，通过环境变量 ATD_CUDA_DIR 指定。
开发版：可指向已有 torch 的 lib 目录复用 cublas/cudnn，免装 nvidia wheel。
"""
import os
import sys


def _cuda_dirs():
    """候选 CUDA DLL 目录：ATD_CUDA_DIR（发布版 GPU 包 / 开发版 torch lib）+ pip 的 nvidia-*-cu12 包。"""
    dirs = []
    env = os.environ.get("ATD_CUDA_DIR")
    if env:
        dirs.append(env)
    sp = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")
    if os.path.isdir(sp):
        for name in os.listdir(sp):
            b = os.path.join(sp, name, "bin")
            if os.path.isdir(b):
                dirs.append(b)
    return [d for d in dirs if os.path.isdir(d)]


def has_cublas():
    """已配置目录里是否存在 cublas 运行库。

    基础包默认不含 CUDA；若只看 get_cuda_device_count()（仅凭驱动），有 N 卡时会
    误判为可用 GPU，随后加载失败（见 findings F16）。这里先确认 cublas 存在。
    """
    for d in _cuda_dirs():
        try:
            for name in os.listdir(d):
                low = name.lower()
                if low.startswith("cublas64_") or low.startswith("cublaslt64_"):
                    return True
        except OSError:
            continue
    return False


def setup_cuda_dlls() -> None:
    """把候选目录加入 DLL 搜索路径（os.add_dll_directory + PATH）。"""
    for d in _cuda_dirs():
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
    if not has_cublas():
        return "cpu", "int8"
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"
