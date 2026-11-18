"""Dice de la U-Net (y de la segmentación clásica) contra las máscaras CORREGIDAS a mano.

Las máscaras corregidas salen de la herramienta local del portal (/mascaras,
src/services/MaskService.js): data-local/ml/corrected-masks/<clave>.npy (uint8
240 × 320; 0 fondo, 1 pie a la izquierda de la imagen, 2 a la derecha). Son
contornos independientes de las etiquetas débiles con las que se entrenó la
U-Net, así que este Dice sí mide la calidad de la segmentación.

Por réplica: Dice por pie (1 y 2) y Dice del pie como un todo (fondo vs pie).
Agregado: media, mediana y percentil 10, y la media por paciente (cada
paciente pesa igual aunque tenga varias réplicas corregidas). Se separa la
partición de validación de la U-Net (pacientes que no vio al entrenar), con la
misma división por paciente que scripts/ml/train_unet.py.

Salida: data-local/ml/dice-corrected.json (sólo agregados).
Uso: python -I scripts/ml/dice_corrected.py [--min 1]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import argparse  # noqa: E402
import json  # noqa: E402

import numpy as np  # noqa: E402

import common as C  # noqa: E402

CORR = C.DATA / "ml" / "corrected-masks"
UNET = C.DATA / "ml" / "unet-masks"


def dice(a, b):
    s = a.sum() + b.sum()
    return 1.0 if s == 0 else float(2 * np.logical_and(a, b).sum() / s)


def scores(ref, pred):
    return {
        "pie1": dice(ref == 1, pred == 1),
        "pie2": dice(ref == 2, pred == 2),
        "pies": dice(ref > 0, pred > 0),
    }


def agg(vals):
    v = np.array(vals, dtype=float)
    if not len(v):
        return None
    return {"n": int(len(v)), "media": round(float(v.mean()), 4), "mediana": round(float(np.median(v)), 4),
            "p10": round(float(np.percentile(v, 10)), 4), "min": round(float(v.min()), 4)}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--min", type=int, default=1, help="mínimo de máscaras corregidas para informar")
    args = ap.parse_args(argv)
    files = sorted(CORR.glob("*.npy")) if CORR.exists() else []
    if len(files) < args.min:
        print(f"Hay {len(files)} máscaras corregidas (mínimo {args.min}). Corregí réplicas en /mascaras del portal.")
        return 2
    index = {e["key"]: e for e in C.load_index()}
    # Pacientes de validación de la U-Net: misma división que train_unet.py.
    li = C.DATA / "ml" / "labels" / "index.json"
    val = C.patient_split([r["codigo"] for r in json.loads(li.read_text(encoding="utf8"))]) if li.exists() else set()
    rows = []
    for f in files:
        key = f.stem
        ref = np.load(f)
        if ref.shape != (C.H, C.W):
            continue
        e = index.get(key, {})
        row = {"key": key, "codigo": e.get("codigo"), "validacion": e.get("codigo") in val}
        u = UNET / f"{key}.npy"
        if u.exists():
            row["unet"] = scores(ref, np.load(u))
        c = C.CACHE / f"{key}_cls.npy"
        if c.exists():
            row["clasica"] = scores(ref, np.load(c))
        rows.append(row)
    res = {"mascarasCorregidas": len(rows), "pacientes": len({r["codigo"] for r in rows})}
    for metodo in ("unet", "clasica"):
        rs = [r for r in rows if metodo in r]
        out = {}
        for k in ("pies", "pie1", "pie2"):
            out[k] = agg([r[metodo][k] for r in rs])
        per_pat = {}
        for r in rs:
            per_pat.setdefault(r["codigo"], []).append(r[metodo]["pies"])
        out["porPaciente"] = agg([np.mean(v) for v in per_pat.values()])
        if val:
            out["soloValidacion"] = agg([r[metodo]["pies"] for r in rs if r["validacion"]])
        res[metodo] = out
    (C.DATA / "ml" / "dice-corrected.json").write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf8")
    print(json.dumps(res, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
