# -*- coding: utf-8 -*-
"""从 APK(zip) 里抽一个条目到指定文件。

为什么用 Python 而不用 unzip：
  · 本机 Git Bash 的 PATH 时好时坏，unzip 不保证在；
  · Python 的 zipfile 与编码无关，中文路径也不会出岔子
    （打 APK 时判 d8 崩、aapt2 认不得中文路径，都是这一类坑）。

用法：python extract-asset.py <apk> <apk内部路径> <输出文件>
"""
import sys
import zipfile

if len(sys.argv) != 4:
    sys.stderr.write("用法: extract-asset.py <apk> <内部路径> <输出文件>\n")
    sys.exit(2)

apk, inner, out = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(apk) as z:
    data = z.read(inner)
with open(out, "wb") as f:
    f.write(data)
print("抽出 %s -> %s (%d 字节)" % (inner, out, len(data)))
