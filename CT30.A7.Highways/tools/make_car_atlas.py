#!/usr/bin/env python3
"""CT30.A7.Highways -- process the top-down car photos into a recolourable atlas.

    python3 tools/make_car_atlas.py "/mnt/c/Users/micha/Downloads/claude/images/cars"   # -> CT30.A7.Highways_cars.js

For every car:
  1. cut it out of its studio background with GrabCut (OpenCV), starting from a box round the car's edges (a fixed box
     where the automatic one fails: "electric 1", whose photo has a stone slab beside the car); keep the biggest piece,
     fill holes, feather the edge;
  2. turn it so its FRONT points right (+x in the atlas = forward in the simulation). Which end is the front was read
     from the photos: the door mirrors sit nearer the front;
  3. make it recolourable: keep only the brightness, then bend it (a gamma curve) so the body paint of every car,
     black or white, ends up mid grey (0.62). The page multiplies that by a paint colour; windows stay dark and
     highlights stay bright, so any car can be any colour;
  4. pack it into a 4 x 4 atlas of 1024 x 512 slots (RGBA WebP; alpha = the cut-out), stored as a data: URL in a
     .js file so the page works opened from disk.
Its length in metres and the photo's aspect give each car its width in the simulation (no stretching).
Needs: pip install opencv-python-headless scipy pillow numpy
"""
import base64, io, os, sys
import numpy as np, cv2
from scipy import ndimage as ndi
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else '/mnt/c/Users/micha/Downloads/claude/images/cars'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'CT30.A7.Highways_cars.js')
# name, type, front ('right' / 'left' / 'up' in the photo), length m, fixed GrabCut box on a 512-wide copy (or None, or
# 'rect' = automatic box, then fill the bounding rectangle: pickup 2's black bed matches the floor)
CARS = [
    ('suv 1', 'suv', 'right', 4.85, None), ('suv 2', 'suv', 'left', 4.85, None), ('suv 3', 'suv', 'left', 4.6, None),
    ('suv 4', 'suv', 'left', 4.8, None), ('van 1', 'van', 'right', 5.6, None), ('pickup 1', 'pickup', 'right', 5.9, None),
    ('pickup 2', 'pickup', 'right', 5.9, 'rect'), ('sports 1', 'sports', 'up', 4.5, None), ('station 1', 'station', 'right', 4.9, None),
    ('sedan 1', 'sedan', 'left', 4.9, None), ('electric 1', 'electric', 'right', 4.5, (72, 168, 375, 172)),
]
SW, SH, N = 1024, 512, 4


def cutout(path, box):
    rect_fill = box == 'rect'                               # boxy vehicles whose black parts vanish into the floor: fill the bounding rectangle
    if rect_fill:
        box = None
    rgb = np.asarray(Image.open(path).convert('RGB'))
    H, W = rgb.shape[:2]
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    s = 512 / W
    small = cv2.resize(bgr, (512, int(round(H * s))))
    if box is None:
        edges = cv2.dilate(cv2.Canny(small, 30, 90), np.ones((9, 9)))
        ys, xs = np.nonzero(edges)
        sel = (xs > 8) & (xs < 503) & (ys > 8) & (ys < small.shape[0] - 8)
        x0, x1 = np.percentile(xs[sel], [1, 99]); y0, y1 = np.percentile(ys[sel], [1, 99])
        x0, y0 = max(2, x0 - 6), max(2, y0 - 6)
        box = (int(x0), int(y0), int(min(509, x1 + 6) - x0), int(min(small.shape[0] - 3, y1 + 6) - y0))
    mask = np.zeros(small.shape[:2], np.uint8)
    cv2.grabCut(small, mask, box, np.zeros((1, 65)), np.zeros((1, 65)), 6, cv2.GC_INIT_WITH_RECT)
    m = (mask == 1) | (mask == 3)
    m = ndi.binary_opening(m, iterations=2)
    lab, k = ndi.label(m)
    if k:
        m = lab == 1 + int(np.argmax(ndi.sum(m, lab, range(1, k + 1))))
    m = ndi.binary_fill_holes(m)
    # a car seen from above is nearly convex: the filled outline closes gaps where black glass or a black pickup bed
    # matched the black studio floor (pickup 2, sedan 1); the little wedges it adds beside the mirrors read as shadow
    ys, xs = np.nonzero(m)
    hull = cv2.convexHull(np.stack([xs, ys], 1).astype(np.int32))
    hm = np.zeros(m.shape, np.uint8); cv2.fillConvexPoly(hm, hull, 1)
    m = hm.astype(bool)
    if rect_fill:
        ys, xs = np.nonzero(m); m = np.zeros_like(m); m[ys.min():ys.max() + 1, xs.min():xs.max() + 1] = True
    # back to full size, feathered edge
    a = cv2.resize(m.astype(np.float32), (W, H), interpolation=cv2.INTER_LINEAR)
    a = cv2.GaussianBlur(a, (0, 0), 1.2 / s)
    a = np.clip((a - 0.5) * 2.2 + 0.5, 0, 1)
    return rgb.astype(np.float32) / 255, a


def process(name, front, length, box):
    rgb, a = cutout(os.path.join(SRC, name + '.webp'), box)
    # front to the right
    k = {'right': 0, 'up': 3, 'left': 2}[front]           # number of 90-degree turns anticlockwise (np.rot90)
    rgb, a = np.rot90(rgb, k).copy(), np.rot90(a, k).copy()
    ys, xs = np.nonzero(a > 0.5)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    rgb, a = rgb[y0:y1, x0:x1], a[y0:y1, x0:x1]
    # brightness only, gamma-bent so the body paint (70th percentile inside the car) becomes 0.62
    L = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    inside = a > 0.9
    p70 = float(np.clip(np.percentile(L[inside], 70), 0.03, 0.97))
    g = max(0.33, np.log(0.62) / np.log(p70))                  # dark cars: brighten, but not so far that the noise shows
    if g < 0.6:                                                 # ... and smooth them first (edge-preserving)
        L = cv2.bilateralFilter(L.astype(np.float32), 9, 0.04, 5)
    Lg = np.clip(L, 0, 1) ** g
    aspect = (x1 - x0) / (y1 - y0)
    return Lg, a, aspect, p70, g


def main():
    atlas = np.zeros((SH * N, SW * N, 4), np.float32)
    meta = []
    for i, (name, typ, front, length, box) in enumerate(CARS):
        Lg, a, aspect, p70, g = process(name, front, length, box)
        # fit into the slot (8 px margin), keeping the aspect
        w = SW - 16; h = int(round(w / aspect))
        if h > SH - 16:
            h = SH - 16; w = int(round(h * aspect))
        Li = cv2.resize(Lg, (w, h), interpolation=cv2.INTER_AREA)
        ai = cv2.resize(a, (w, h), interpolation=cv2.INTER_AREA)
        sx, sy = (i % N) * SW + (SW - w) // 2, (i // N) * SH + (SH - h) // 2
        atlas[sy:sy + h, sx:sx + w, 0] = Li; atlas[sy:sy + h, sx:sx + w, 1] = Li; atlas[sy:sy + h, sx:sx + w, 2] = Li
        atlas[sy:sy + h, sx:sx + w, 3] = ai
        # uv box of the car inside the atlas (v up, as WebGL samples it after the default flipY)
        u0, u1 = sx / (SW * N), (sx + w) / (SW * N)
        v1, v0 = 1 - sy / (SH * N), 1 - (sy + h) / (SH * N)
        meta.append({'name': name, 'type': typ, 'length': length, 'width': round(length / aspect, 3), 'uv': [round(u0, 6), round(v0, 6), round(u1, 6), round(v1, 6)]})
        print(f'{name:12s} {typ:8s} front {front:5s} aspect {aspect:.2f} -> {length} x {length / aspect:.2f} m   body brightness {p70:.2f} -> 0.62 (gamma {g:.2f})')
    img = Image.fromarray((np.clip(atlas, 0, 1) * 255).astype(np.uint8), 'RGBA')
    buf = io.BytesIO(); img.save(buf, 'WEBP', quality=88, method=6, exact=True)
    with open(OUT, 'w') as fh:
        fh.write('/* CT30.A7.Highways -- the car atlas, made by tools/make_car_atlas.py from C:\\Users\\micha\\Downloads\\claude\\images\\cars\n'
                 ' * (cut out, front to the right, brightness only with the paint at mid grey so the page can recolour it). */\n')
        fh.write('window.CT30_CARS = ' + __import__('json').dumps({'cars': meta, 'grid': N, 'slot': [SW, SH]}) + ";\nwindow.CT30_CARS.url = 'data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode() + "';\n")
    os.makedirs(os.path.join(os.path.dirname(OUT), 'docs'), exist_ok=True)
    img.save(os.path.join(os.path.dirname(OUT), 'docs', 'A7_car_atlas.png'))
    print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB')


if __name__ == '__main__':
    main()
