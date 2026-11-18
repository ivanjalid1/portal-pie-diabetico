"""Control de dominio de la U-Net con las segmentaciones de la base pública 2019.

La base (Hernández-Contreras et al. 2019, CC BY 4.0) trae cada pie YA
SEGMENTADO por sus autores (fondo = 0) y recortado: no trae la escena
original. Por eso NO se puede medir la U-Net sobre sus imágenes tal cual.
Este script arma una escena SINTÉTICA de 320 × 240 por sujeto: los dos pies
recortados en su lugar (el lado medial de cada uno hacia el centro), sobre un
fondo suave unos grados más frío que el pie, y compara la máscara de la U-Net
con la de los autores (Dice del pie como un todo y por pie).

Es un control de que la U-Net reconoce pies de otra cámara y otro protocolo,
NO una validación de la segmentación en escenas reales: el fondo es
artificial y no hay tela, piernas ni objetos. La validación con contornos
independientes de la cohorte es scripts/ml/dice_corrected.py.

Uso: python -I scripts/ml/dice_public.py
Salida: data-local/ml/dice-public.json (sólo agregados).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import json  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from scipy import ndimage as ndi  # noqa: E402

import common as C  # noqa: E402
from segment_unet import postprocess  # noqa: E402
from train_unet import UNet  # noqa: E402

torch.set_num_threads(C.NUM_THREADS)
BASE = C.DATA / "public" / "hernandez2019" / "ThermoDataBase"


def read_csv(p):
    return np.loadtxt(p, delimiter=",", dtype=np.float32)


def medial_left(side_dir, name, side):
    """True si el lado medial (MPA + MCA) del recorte está a la izquierda."""
    xs = {}
    for a in ("MPA", "MCA", "LPA", "LCA"):
        m = read_csv(side_dir / "Angiosoms" / f"{name}_{side}_{a}.csv") > 0
        xs[a] = np.nonzero(m)[1]
    med = np.concatenate([xs["MPA"], xs["MCA"]]).mean()
    lat = np.concatenate([xs["LPA"], xs["LCA"]]).mean()
    return med < lat


def scene(L, R, rng):
    """Escena 240 × 320: pie con el medial a la derecha a la izquierda de la imagen y viceversa."""
    feet = [L, R]
    s = min(1.0, 220 / max(f.shape[0] for f in feet), 140 / max(f.shape[1] for f in feet))
    if s < 1:
        feet = [ndi.zoom(f, s, order=0) for f in feet]
    temps = np.concatenate([f[f > 0] for f in feet])
    amb = np.percentile(temps, 5) - rng.uniform(2.0, 4.0)
    bg = ndi.gaussian_filter(rng.normal(0, 1, (C.H, C.W)), 12)
    T = (amb + 0.6 * bg / (bg.std() + 1e-6)).astype(np.float32)
    lab = np.zeros((C.H, C.W), np.uint8)
    gap = 10
    for k, f in enumerate(feet):
        h, w = f.shape
        y0 = (C.H - h) // 2
        x0 = C.W // 2 - gap - w if k == 0 else C.W // 2 + gap
        m = f > 0
        T[y0 : y0 + h, x0 : x0 + w][m] = f[m]
        lab[y0 : y0 + h, x0 : x0 + w][m] = k + 1
    return T, lab


def dice(a, b):
    s = a.sum() + b.sum()
    return 1.0 if s == 0 else float(2 * np.logical_and(a, b).sum() / s)


def main():
    if not BASE.exists():
        print("Sin base pública en data-local/public/hernandez2019/.")
        return 2
    ck = torch.load(C.MODELS / "unet-feet.pt")
    model = UNet()
    model.load_state_dict(ck["state"])
    model.eval()
    rng = np.random.default_rng(0)
    rows = []
    for grp in ("Control Group", "DM Group"):
        for d in sorted((BASE / grp).iterdir()):
            name = d.name
            try:
                crops = {}
                for side in ("L", "R"):
                    t = read_csv(d / f"{name}_{side}.csv")
                    # Medial hacia el centro: el pie de la izquierda de la escena con el medial a la derecha.
                    crops[side] = (t, medial_left(d, name, side))
                (tr, mlr), (tl, mll) = crops["R"], crops["L"]
                left = np.ascontiguousarray(tr[:, ::-1] if mlr else tr)
                right = np.ascontiguousarray(tl if mll else tl[:, ::-1])
                T, ref = scene(left, right, rng)
            except (OSError, ValueError):
                continue
            with torch.no_grad():
                x = torch.from_numpy(C.normalize_temp(T))[None, None]
                x = F.interpolate(x, size=(ck["hs"], ck["ws"]), mode="bilinear", align_corners=False)
                logits = F.interpolate(model(x), size=(C.H, C.W), mode="bilinear", align_corners=False)
            pred = postprocess(logits.argmax(1)[0].numpy().astype(np.uint8))
            rows.append({
                "grupo": name[:2],
                "pies": dice(ref > 0, pred > 0),
                "pie1": dice(ref == 1, pred == 1),
                "pie2": dice(ref == 2, pred == 2),
            })

    def agg(v):
        v = np.array(v)
        return {"n": int(len(v)), "media": round(float(v.mean()), 4), "mediana": round(float(np.median(v)), 4),
                "p10": round(float(np.percentile(v, 10)), 4), "min": round(float(v.min()), 4)}
    res = {
        "nota": "Escenas sintéticas (pies segmentados por los autores sobre fondo artificial): control de dominio, no validación.",
        "pies": agg([r["pies"] for r in rows]),
        "porPie": agg([r["pie1"] for r in rows] + [r["pie2"] for r in rows]),
        "CG": agg([r["pies"] for r in rows if r["grupo"] == "CG"]),
        "DM": agg([r["pies"] for r in rows if r["grupo"] == "DM"]),
    }
    (C.DATA / "ml" / "dice-public.json").write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf8")
    print(json.dumps(res, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
