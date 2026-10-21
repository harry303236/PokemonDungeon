# Detects socket rects + XP groove in hud-bar-base.png from luminance profiles (dark interiors between bronze frames).
# Usage: python3 scripts/measure-bar-base.py [path]  -> JSON to paste into BAR_BASE (src/render/hud/hud-art.ts)
import sys, json
from PIL import Image
im = Image.open(sys.argv[1] if len(sys.argv) > 1 else 'public/assets/hud/hud-bar-base.png').convert('RGBA'); W, H = im.size; px = im.load()
L = lambda x, y: sum(px[x, y][:3]) / 3 * px[x, y][3] / 255
def runs(vals, th, minlen):
    out, s = [], None
    for i, v in enumerate(vals + [999]):
        if v < th and s is None: s = i
        if v >= th and s is not None:
            if i - s > minlen: out.append((s, i - 1))
            s = None
    return out
col = [sum(L(x, y) for y in range(170, 230)) / 60 for x in range(W)]
sockets = []
for a, b in runs(col, 32, 40):
    cx = (a + b) // 2
    rows = runs([sum(L(x, y) for x in range(cx - 15, cx + 15)) / 30 for y in range(H)], 32, 30)
    band = [r for r in rows if r[0] > 60 and r[1] < 290 and r[1] - r[0] > 80]
    if band and a > 90 and b < W - 90: sockets.append(dict(x=a, y=band[0][0], w=b - a + 1, h=band[0][1] - band[0][0] + 1))
mid = W // 2
prof = [sum(L(x, y) for x in range(mid - 100, mid + 100)) / 200 for y in range(H)]
g = [r for r in runs(prof, 20, 15) if r[0] > 280]
gy0, gy1 = g[0] if g else (0, 0)
row = [sum(L(x, y) for y in range(gy0 + 3, gy1 - 2)) / max(1, gy1 - gy0 - 5) for x in range(W)]
x0 = mid
while x0 > 0 and row[x0] < 20: x0 -= 1
x1 = mid
while x1 < W - 1 and row[x1] < 20: x1 += 1
print(json.dumps(dict(w=W, h=H, sockets=sockets, xp=dict(x0=x0 + 1, x1=x1 - 1, y0=gy0, y1=gy1))))
