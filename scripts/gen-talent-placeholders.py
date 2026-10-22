"""Generate PLACEHOLDER art for talent v4 (artist replaces these files 1:1, same names/sizes) and the icon manifest.
Run: python3 scripts/gen-talent-placeholders.py  (re-run after the artist drops new talent-<id>.png icons to refresh the manifest;
placeholders are only (re)created when the file is missing or still marked as placeholder in PLACEHOLDERS.json)."""
import json, math, os
from PIL import Image, ImageDraw, ImageFont
ROOT = os.path.join(os.path.dirname(__file__), '..')
T = os.path.join(ROOT, 'public/assets/hud/talents')
V4 = json.load(open(os.path.join(ROOT, 'src/data/build/charmander-talents-v4.json')))
V3 = json.load(open(os.path.join(ROOT, 'src/data/build/charmander-talents.json')))
REG = os.path.join(T, 'PLACEHOLDERS.json')
# placeholders the artist has replaced with real art (removed from the registry; files may be deleted or overwritten in place)
REPLACED = {'ascendancy/asc-asc_flame_wing.png', 'ascendancy/asc-asc_dragon_blood.png', 'jewels/jewel-normal.png', 'jewels/jewel-jw_solar_lens.png', 'jewels/jewel-jw_dragon_heart.png',
            'jewels/jewel-jw_tailwind.png', 'talent-frame-jewel-socket.png', 'talent-frame-ascendancy.png', 'ascendancy/asc-asc_fw_1.png', 'ascendancy/asc-asc_fw_2.png', 'ascendancy/asc-asc_fw_3.png',
            'ascendancy/asc-asc_db_1.png', 'ascendancy/asc-asc_db_2.png', 'ascendancy/asc-asc_db_3.png'}
placeholders = json.load(open(REG)) if os.path.exists(REG) else []
FONT = next((f for f in ['/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', '/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'] if os.path.exists(f)), None)
def font(sz): return ImageFont.truetype(FONT, sz) if FONT else ImageFont.load_default()

def want(rel):
    p = os.path.join(T, rel)
    return (not os.path.exists(p)) or rel in placeholders
def mark(rel):
    if rel not in placeholders: placeholders.append(rel)

def badge(rel, glyph, c1, c2, size=128):
    if not want(rel): return
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    for r in range(size // 2, 0, -1):
        t = r / (size / 2); col = tuple(int(c1[i] * t + c2[i] * (1 - t)) for i in range(3)) + (255,)
        d.ellipse([size / 2 - r, size / 2 - r, size / 2 + r, size / 2 + r], fill=col)
    f = font(int(size * 0.42)); w = d.textlength(glyph, font=f)
    d.text(((size - w) / 2, size * 0.22), glyph, font=f, fill=(255, 240, 210, 255), stroke_width=3, stroke_fill=(30, 10, 5, 255))
    d.text((6, size - 22), 'PH', font=font(14), fill=(255, 255, 255, 140))
    im.save(os.path.join(T, rel)); mark(rel)

def ring_frame(rel, size, color, inner=0.62, gem=False):
    if not want(rel): return
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0)); d = ImageDraw.Draw(im); c = size / 2
    for i, a in enumerate([255, 200, 140]):
        r = c - 4 - i * 6; d.ellipse([c - r, c - r, c + r, c + r], outline=color + (a,), width=6)
    ri = c * inner; d.ellipse([c - ri, c - ri, c + ri, c + ri], outline=(40, 30, 20, 255), width=5)
    for k in range(8 if gem else 4):
        ang = k * math.pi * 2 / (8 if gem else 4) - math.pi / 2; x, y = c + math.cos(ang) * (c - 10), c + math.sin(ang) * (c - 10)
        d.polygon([(x, y - 9), (x + 7, y), (x, y + 9), (x - 7, y)], fill=color + (255,))
    im.save(os.path.join(T, rel)); mark(rel)

# new notables (no v3 art)
badge('icons/talent-sun_N3.png', '冕', (255, 190, 60), (120, 30, 0))
badge('icons/talent-claw_N3.png', '逆', (220, 60, 40), (60, 0, 0))
badge('icons/talent-wing_N3.png', '流', (255, 140, 60), (40, 20, 70))
# ascendancy sub-node badges + frame (artist art now delivered in place; only recreated if a file goes missing)
REAL_ENTRY = {'asc_flame_wing', 'asc_dragon_blood'}  # entries use artist names ascendancy/<id>.png
for a in V4['ascendancy']:
    if a['id'] in REAL_ENTRY: continue
    fw = a['id'].startswith('asc_f'); badge(f"ascendancy/asc-{a['id']}.png", a['name'][0], (255, 150, 50) if fw else (120, 80, 220), (90, 20, 0) if fw else (20, 10, 60))
ring_frame('talent-frame-ascendancy.png', 256, (230, 120, 255))
# jewels + socket frames: artist art (jewels/jw_*.png, jewels/jewel-socket-{empty,filled}.png) -- no placeholders any more
placeholders = [p for p in placeholders if os.path.exists(os.path.join(T, p)) and p not in REPLACED]
json.dump(sorted(placeholders), open(REG, 'w'), ensure_ascii=False, indent=2)

# icon manifest: talent-<v4id>.png > v3 icon with same name > v3 icon with same effectType > generic placeholder
icons = set(os.listdir(os.path.join(T, 'icons')))
v3_by_name = {n['name']: n['id'] for n in V3['nodes']}; v3_by_eff = {}
for n in V3['nodes']: v3_by_eff.setdefault(n['effectType'], n['id'])
man = {}
for n in V4['nodes']:
    cands = [n['id'], v3_by_name.get(n['name']), v3_by_eff.get(n['effectType'])] if n['kind'] != 'start' else [n['id'], 'root']
    pick = next((c for c in cands if c and f'talent-{c}.png' in icons), None)
    man[n['id']] = f'icons/talent-{pick}.png' if pick else None
for a in V4['ascendancy']: man[a['id']] = f"ascendancy/{a['id']}.png" if a['id'] in REAL_ENTRY else f"ascendancy/asc-{a['id']}.png"
json.dump(man, open(os.path.join(ROOT, 'src/data/build/talent-icons-v4.json'), 'w'), ensure_ascii=False, indent=1)
print('placeholders:', len(placeholders), 'manifest:', sum(1 for v in man.values() if v), '/', len(man))
