# -*- coding: utf-8 -*-
"""PyInstaller 打包入口：把 engine.cli 冻结成 engine.exe（onedir）。

打包时从项目根（Desktop/）运行，保证 `engine` 包可被收集：
  pyinstaller --onedir --name engine --paths . ... engine/pyinstaller_entry.py
"""
import sys

from engine.cli import main

if __name__ == "__main__":
    sys.exit(main())
