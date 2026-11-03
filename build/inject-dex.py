# -*- coding: utf-8 -*-
"""
生死转盘 · 构建工具：把 d8 产出的 classes.dex 合进 aapt2 生成的 APK。

    python build/inject-dex.py <base.apk> <classes.dex> <out.apk>

为什么单独用 Python：本机没有 zip 命令行工具，而 Python 标准库自带
zipfile，能确定性地往已有归档里追加一个条目，不破坏原有条目顺序。
"""
import shutil
import sys
import zipfile


def main():
    if len(sys.argv) != 4:
        print('用法：python inject-dex.py <base.apk> <classes.dex> <out.apk>')
        return 1
    base, dex, out = sys.argv[1], sys.argv[2], sys.argv[3]

    shutil.copyfile(base, out)
    with zipfile.ZipFile(out, 'a', zipfile.ZIP_DEFLATED) as z:
        names = z.namelist()
        if 'classes.dex' in names:
            print('out.apk 里已经有 classes.dex 了，跳过')
            return 0
        z.write(dex, 'classes.dex')
    print('已注入 classes.dex')
    return 0


if __name__ == '__main__':
    sys.exit(main())
