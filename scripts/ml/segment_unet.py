"""Aplica la U-Net entrenada a todas las réplicas exportadas y evalúa contra la clásica.

Salida (local):
  data-local/ml/unet-masks/<clave>.npy   etiquetas 0/1/2 a resolución completa (240 × 320)
  data-local/ml/unet-eval.json           métricas agregadas (sin datos por paciente)

Post-proceso de la U-Net: logits reescalados a 240 × 320 (bilineal), argmax,
y por pie: apertura 3×3, componente mayor y relleno de huecos.

Métricas:
  - Dice / IoU de la U-Net contra la etiqueta débil refinada en los pacientes de
    VALIDACIÓN (división por paciente del entrenamiento): imágenes «limpias» y todas.
  - Indicadores automáticos de error en todas las imágenes, clásica vs U-Net:
      fuga en el talón  = algún pie con largo/ancho > 3,4 (pierna o tela);
      puente            = los dos pies se tocan (tela entre los talones);
      pie incompleto    = algún pie con largo/ancho < 2,0 (dedos o talón perdidos).

Uso: python scripts/ml/segment_unet.py
"""
import json

import numpy as np
import torch
import torch.nn.functional as F
from scipy import ndimage as ndi

import common as C
from train_unet import UNet

torch.set_num_threads(C.NUM_THREADS)
OUT = C.DATA / "ml" / "unet-masks"
LABELS = C.DATA / "ml" / "labels"


def postprocess(pred: np.ndarray) -> np.ndarray:
    out = np.zeros_like(pred, dtype=np.uint8)
    for k in (1, 2):
        m = ndi.binary_opening(pred == k, structure=np.ones((3, 3)))
        if m.sum() == 0:
            continue
        lab, n = ndi.label(m)
        sizes = ndi.sum(m, lab, range(1, n + 1))
        m = ndi.binary_fill_holes(lab == (int(np.argmax(sizes)) + 1))
        out[m & (out == 0)] = k
    return out


def flags(lab: np.ndarray) -> dict:
    ratios = [C.length_ratio(lab == k) for k in (1, 2)]
    a, b = lab == 1, lab == 2
    return {
        "fugaTalon": any(r is not None and r > C.MAX_LARGO_ANCHO for r in ratios),
        "puente": bool((ndi.binary_dilation(a, iterations=1) & b).any()),
        "incompleto": any(r is None or r < 2.0 for r in ratios),
    }


def main():
    ck = torch.load(C.MODELS / "unet-feet.pt")
    model = UNet()
    model.load_state_dict(ck["state"])
    model.eval()
    val_codes = set(ck["val_codes"])
    rows = {r["key"]: r for r in json.loads((LABELS / "index.json").read_text(encoding="utf8"))}
    OUT.mkdir(parents=True, exist_ok=True)
    res = []
    with torch.no_grad():
        for e in C.load_index():
            if not e.get("exportado"):
                continue
            t = np.asarray(C.load_temp(e["key"]))
            x = torch.from_numpy(C.normalize_temp(t))[None, None]
            x = F.interpolate(x, size=(ck["hs"], ck["ws"]), mode="bilinear", align_corners=False)
            logits = F.interpolate(model(x), size=(C.H, C.W), mode="bilinear", align_corners=False)
            pred = postprocess(logits.argmax(1)[0].numpy().astype(np.uint8))
            np.save(OUT / f"{e['key']}.npy", pred)
            cls = C.load_classic(e["key"])
            ref = np.load(LABELS / f"{e['key']}.npy")
            r = rows.get(e["key"], {})
            d, j = zip(*[C.dice_iou(pred == k, ref == k) for k in (1, 2)])
            res.append(
                {
                    "val": e["codigo"] in val_codes,
                    "limpia": bool(r.get("limpia")),
                    "flagged": (e.get("calidad") or 0) < 0.6,
                    "dice": float(np.mean(d)),
                    "iou": float(np.mean(j)),
                    "clasica": flags(cls),
                    "unet": flags(pred),
                }
            )

    def agg(sel):
        return {
            "n": len(sel),
            "dice": round(float(np.mean([r["dice"] for r in sel])), 4) if sel else None,
            "iou": round(float(np.mean([r["iou"] for r in sel])), 4) if sel else None,
        }

    def counts(sel, src):
        return {k: int(sum(r[src][k] for r in sel)) for k in ("fugaTalon", "puente", "incompleto")}

    flagged = [r for r in res if r["flagged"]]
    out = {
        "checkpoint": {"epoca": ck["epoch"] + 1, "diceVal": round(ck["dice"], 4), "iouVal": round(ck["iou"], 4)},
        "valLimpias": agg([r for r in res if r["val"] and r["limpia"]]),
        "valTodas": agg([r for r in res if r["val"]]),
        "trainLimpias": agg([r for r in res if not r["val"] and r["limpia"]]),
        "imagenes": len(res),
        "indicadores": {"clasica": counts(res, "clasica"), "unet": counts(res, "unet")},
        "flagged": {"n": len(flagged), "clasica": counts(flagged, "clasica"), "unet": counts(flagged, "unet")},
    }
    (C.DATA / "ml" / "unet-eval.json").write_text(json.dumps(out, indent=2), encoding="utf8")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
