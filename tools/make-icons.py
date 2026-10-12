#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""由两张源图生成两套软件图标。

    桌面识别端  Desktop.png -> desktop-overlay/src/GomokuOverlay.ico   （编进 GomokuOverlay.exe）
    网页书签端  web.png     -> tools/build/GomokuWeb.ico               （打进 GomokuEngine.exe）

为什么单独一个脚本：图标是**发布资产**，不该由每次编译顺手重算——
源图换一次跑一次就够；而编译链路上多一步外部依赖就多一个"某天突然编不出来"的风险。

用法：
    python tools/make-icons.py [Desktop.png 路径] [web.png 路径]

依赖 Pillow。优先用 engine-server/python/.venv 里那份（项目自带的识别环境），
找不到再退回系统 python。
"""
import os
import sys

SIZES = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]


def build(src, dst, label):
    from PIL import Image
    if not os.path.exists(src):
        print('[icon] MISSING source: %s' % src)
        return False
    im = Image.open(src)
    print('[icon] source %s  %s  %dx%d' % (label, src, im.size[0], im.size[1]))
    # 图标必须是方的：源图不是就居中裁一块，免得被拉变形。
    if im.size[0] != im.size[1]:
        s = min(im.size)
        l = (im.size[0] - s) // 2
        t = (im.size[1] - s) // 2
        im = im.crop((l, t, l + s, t + s))
    im = im.convert('RGBA')
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    im.save(dst, format='ICO', sizes=SIZES)
    print('[icon] -> %s  (%d bytes)' % (dst, os.path.getsize(dst)))
    return True


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    a = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.expanduser('~'), 'Desktop', 'Desktop.png')
    b = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.expanduser('~'), 'Desktop', 'web.png')
    ok1 = build(a, os.path.join(root, 'desktop-overlay', 'src', 'GomokuOverlay.ico'), 'Desktop')
    ok2 = build(b, os.path.join(root, 'tools', 'build', 'GomokuWeb.ico'), 'Web')
    if not (ok1 and ok2):
        print('[icon] 至少一个源图缺失，图标未全部生成')
        return 1
    print('[icon] done')
    return 0


if __name__ == '__main__':
    sys.exit(main())
