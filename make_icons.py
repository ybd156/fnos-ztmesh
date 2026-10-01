"""Generate ZeroTier-styled icons for the fnOS fpk package."""
import math
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'fpk')


def make_icon(size):
    S = size * 8  # supersample for smooth edges
    # --- vertical gradient background (ZeroTier blue) ---
    bg = Image.new('RGB', (S, S))
    bd = ImageDraw.Draw(bg)
    for y in range(S):
        t = y / max(1, S - 1)
        rr = int(24 + (56 - 24) * t)
        gg = int(52 + (140 - 52) * t)
        bb = int(110 + (246 - 110) * t)
        bd.line([(0, y), (S, y)], fill=(rr, gg, bb))

    # --- rounded-square mask ---
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)

    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    img.paste(bg, (0, 0), mask)
    d = ImageDraw.Draw(img)

    # --- node network motif: central hub + satellites + links ---
    cx, cy = S / 2.0, S / 2.0
    orbit = S * 0.30
    node_r = S * 0.052
    hub_r = S * 0.085
    white = (255, 255, 255, 255)
    line_col = (255, 255, 255, 150)

    sat = []
    for i in range(6):
        a = -90 + i * 60
        rad = math.radians(a)
        sat.append((cx + orbit * math.cos(rad), cy + orbit * math.sin(rad)))

    # links hub -> satellites
    for (x, y) in sat:
        d.line([(cx, cy), (x, y)], fill=line_col, width=max(2, int(S * 0.016)))
    # ring links between satellites
    for i in range(len(sat)):
        x1, y1 = sat[i]
        x2, y2 = sat[(i + 1) % len(sat)]
        d.line([(x1, y1), (x2, y2)], fill=(255, 255, 255, 90), width=max(2, int(S * 0.010)))

    # satellites
    for (x, y) in sat:
        d.ellipse([x - node_r, y - node_r, x + node_r, y + node_r], fill=white)
    # hub
    d.ellipse([cx - hub_r, cy - hub_r, cx + hub_r, cy + hub_r], fill=white)
    d.ellipse([cx - hub_r * 0.42, cy - hub_r * 0.42, cx + hub_r * 0.42, cy + hub_r * 0.42],
              fill=(37, 99, 235, 255))

    return img.resize((size, size), Image.LANCZOS)


def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, 'PNG')
    print('wrote', path, img.size)


if __name__ == '__main__':
    for size in (64, 256):
        ic = make_icon(size)
        save(ic, os.path.join(OUT, 'ICON.PNG' if size == 64 else 'ICON_256.PNG'))
        save(ic, os.path.join(OUT, 'app', 'ui', 'images', 'icon_%d.png' % size))
