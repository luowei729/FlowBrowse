#!/usr/bin/env python3
# gen_icons.py —— 用 PIL 生成 FlowBrowse 工具栏图标：蓝=开启、灰=关闭，白色 ⇄ 交换符号
from PIL import Image, ImageDraw, ImageFont
import os

os.makedirs('icons', exist_ok=True)
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
BLUE = (26, 115, 232, 255)   # 开启：品牌蓝
GRAY = (150, 158, 168, 255)  # 关闭：灰
WHITE = (255, 255, 255, 255)


def make(size, bg, path):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = max(2, int(size * 0.22))
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=bg)
    ch = '\u21c4'  # ⇄
    try:
        f = ImageFont.truetype(FONT, int(size * 0.66))
        bb = d.textbbox((0, 0), ch, font=f)
        w, h = bb[2] - bb[0], bb[3] - bb[1]
        d.text(((size - w) / 2 - bb[0], (size - h) / 2 - bb[1]), ch, font=f, fill=WHITE)
    except Exception:
        # 兜底：画两条相反方向的箭头
        wd = max(1, size // 9)
        d.line([size * 0.28, size * 0.40, size * 0.72, size * 0.40], fill=WHITE, width=wd)
        d.line([size * 0.28, size * 0.60, size * 0.72, size * 0.60], fill=WHITE, width=wd)
    img.save(path)


for s in (16, 18, 24, 32, 48, 128):
    make(s, BLUE, f'icons/icon-on-{s}.png')
    make(s, GRAY, f'icons/icon-off-{s}.png')
    make(s, BLUE, f'icons/icon-{s}.png')  # manifest 默认（蓝）
print('icons generated:', sorted(os.listdir('icons')))
