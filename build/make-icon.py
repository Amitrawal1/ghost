#!/usr/bin/env python3
"""Generates build/icon.png (1024x1024): a simple white ghost on a dark rounded square.
Run: python3 build/make-icon.py  (needs Pillow)"""
import os
from PIL import Image, ImageDraw

S = 1024
SS = 4  # supersample for smooth edges
N = S * SS
img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# macOS-style rounded-square background (inset ~10% like Apple's icon grid)
pad = int(N * 0.09)
d.rounded_rectangle([pad, pad, N - pad, N - pad], radius=int(N * 0.18), fill=(22, 24, 34, 255))

# Ghost body: dome + rectangle + wavy bottom
white = (236, 240, 255, 255)
cx = N // 2
w = int(N * 0.44)
left, right = cx - w // 2, cx + w // 2
top = int(N * 0.24)
bottom = int(N * 0.74)
d.ellipse([left, top, right, top + w], fill=white)
d.rectangle([left, top + w // 2, right, bottom], fill=white)
# scalloped hem: 4 bumps
bumps = 4
bw = w / bumps
r = bw / 2
for i in range(bumps):
    x0 = left + i * bw
    d.ellipse([x0, bottom - r, x0 + bw, bottom + r], fill=white)

# eyes
bg = (22, 24, 34, 255)
ey = top + int(w * 0.45)
er_w, er_h = int(w * 0.09), int(w * 0.14)
for ex in (cx - int(w * 0.17), cx + int(w * 0.17)):
    d.ellipse([ex - er_w, ey - er_h, ex + er_w, ey + er_h], fill=bg)

img = img.resize((S, S), Image.LANCZOS)
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.png")
img.save(out)
print("wrote", out)
