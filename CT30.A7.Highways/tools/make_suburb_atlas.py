#!/usr/bin/env python3
"""Pack the suburb tiles into one 4x4 atlas (1024 px per tile) and write it as a script the page can load from file://
(a texture read from a file:// image is blocked by the browser; a data: URL inside a .js file is not).

    python3 tools/make_suburb_atlas.py "/mnt/c/Users/micha/Downloads/claude/images"     # -> CT30.A7.Highways_suburbs.js
"""
import base64, glob, io, os, re, sys
from PIL import Image

src = sys.argv[1] if len(sys.argv) > 1 else '/mnt/c/Users/micha/Downloads/claude/images'
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'CT30.A7.Highways_suburbs.js')
files = sorted(glob.glob(os.path.join(src, 'suburb *.webp')), key=lambda f: int(re.findall(r'(\d+)', os.path.basename(f))[0]))
S, N = 1024, 4
atlas = Image.new('RGB', (S * N, S * N))
used = []
for k in range(N * N):
    f = files[k % len(files)]
    im = Image.open(f).convert('RGB').resize((S, S), Image.LANCZOS)
    if k >= len(files):
        im = im.transpose(Image.ROTATE_90)        # spare slot: a turned copy, so it is not a duplicate
    atlas.paste(im, ((k % N) * S, (k // N) * S))
    used.append(os.path.basename(f))
buf = io.BytesIO()
atlas.save(buf, 'WEBP', quality=82, method=6)
b64 = base64.b64encode(buf.getvalue()).decode()
with open(out, 'w') as fh:
    fh.write('/* CT30.A7.Highways -- the suburb ground tiles: a 4x4 atlas of 1024 px tiles made by tools/make_suburb_atlas.py from\n'
             ' * ' + ', '.join(used) + '\n * (C:\\Users\\micha\\Downloads\\claude\\images). A data: URL so the page works opened from disk. */\n')
    fh.write(f"window.CT30_SUBURBS = {{ tiles: {N * N}, grid: {N}, px: {S}, files: {used!r}, url: 'data:image/webp;base64,{b64}' }};\n")
print('wrote', out, os.path.getsize(out) // 1024, 'KB from', len(files), 'tiles')
