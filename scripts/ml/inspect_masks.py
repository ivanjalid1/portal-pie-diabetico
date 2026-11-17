"""Hoja de contactos para revisión visual de máscaras (sin datos identificatorios).

Uso: python scripts/ml/inspect_masks.py <salida.png> [flagged|random|ratio] [n] [unet]
Contornos: rojo = clásica, cian = clásica refinada (etiqueta débil), amarillo = U-Net.
Cada mosaico se rotula sólo con un número de orden; la correspondencia con la
clave queda en <salida>.json (local).
"""
import json
import sys

import numpy as np
from PIL import Image, ImageDraw

import common as C


def main():
    out = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else "flagged"
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 24
    with_unet = len(sys.argv) > 4 and sys.argv[4] == "unet"
    idx = [e for e in C.load_index() if e.get("exportado") and e.get("ok")]
    if mode == "flagged":
        sel = [e for e in idx if (e.get("calidad") or 0) < 0.6]
    elif mode == "ratio":
        sel = []
        for e in idx:
            cls = C.load_classic(e["key"])
            r = max((C.length_ratio(cls == k) or 0) for k in (1, 2))
            if r > C.MAX_LARGO_ANCHO:
                sel.append(e)
    else:
        sel = idx
    rng = np.random.default_rng(1)
    if len(sel) > n:
        sel = [sel[i] for i in sorted(rng.choice(len(sel), n, replace=False))]
    tiles = []
    for e in sel:
        t = C.load_temp(e["key"])
        cls = C.load_classic(e["key"])
        ref, _ = C.refine_labels(cls, t)
        labs = [cls, ref]
        if with_unet:
            p = C.DATA / "ml" / "unet-masks" / f"{e['key']}.npy"
            labs.append(np.load(p) if p.exists() else np.zeros_like(cls))
        tiles.append(C.overlay(t, labs))
    cols = 6
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * C.W, max(rows, 1) * C.H), (0, 0, 0))
    d = ImageDraw.Draw(sheet)
    for i, tile in enumerate(tiles):
        x, y = (i % cols) * C.W, (i // cols) * C.H
        sheet.paste(Image.fromarray(tile), (x, y))
        d.text((x + 4, y + 4), str(i), fill=(255, 255, 255))
    sheet.save(out)
    with open(out + ".json", "w", encoding="utf8") as f:
        json.dump([e["key"] for e in sel], f)
    print(f"{len(tiles)} mosaicos -> {out}")


if __name__ == "__main__":
    main()
