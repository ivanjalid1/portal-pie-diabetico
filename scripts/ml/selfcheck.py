"""Autocomprobación rápida de los scripts de ML con datos SINTÉTICOS (sin datos reales).

Uso: python scripts/ml/selfcheck.py
"""
import numpy as np
import torch

import common as C
from segment_unet import flags, postprocess
from train_models import TinyCnn, aug_maps, boot_ci, cv_lr
from train_unet import UNet, augment


def ellipse(cx, cy, a, b, h=C.H, w=C.W):
    yy, xx = np.mgrid[0:h, 0:w]
    return ((xx - cx) / a) ** 2 + ((yy - cy) / b) ** 2 <= 1


def main():
    # Pie sintético: elipse de 30 × 80 px (largo/ancho ≈ 2,7) + «pierna» bajo el talón.
    foot = ellipse(90, 120, 30, 80)
    leg = np.zeros_like(foot)
    leg[195:240, 80:100] = True
    m, info = C.refine_foot(foot | leg)
    r = C.length_ratio(m)
    assert info["corteTalon"] > 0, "debía recortar la pierna"
    assert r is not None and r <= C.MAX_LARGO_ANCHO + 0.05, r
    assert C.dice_iou(m, foot)[0] > 0.93
    # Etiquetas y post-proceso: dos pies, sin puente ni fuga.
    lab = np.zeros((C.H, C.W), np.uint8)
    lab[foot] = 1
    lab[ellipse(230, 120, 30, 80)] = 2
    assert not any(flags(postprocess(lab)).values())
    # División por paciente: ningún paciente en ambos conjuntos.
    codes = [f"P{i % 30}" for i in range(120)]
    val = C.patient_split(codes)
    assert 0 < len(val) < 30
    # U-Net: forma de salida y aumento que intercambia las clases al espejar.
    out = UNet()(torch.zeros(2, 1, 120, 160))
    assert out.shape == (2, 3, 120, 160)
    x, y = augment(torch.rand(4, 1, 120, 160), torch.randint(0, 3, (4, 120, 160)))
    assert x.shape == (4, 1, 120, 160) and y.dtype == torch.long
    # Modelos: AUC ≈ 1 con una feature perfectamente separable, ≈ 0,5 con ruido.
    rng = np.random.default_rng(0)
    yb = np.array([0] * 20 + [1] * 20)
    Xs = np.c_[yb + rng.normal(0, 0.1, 40), rng.normal(0, 1, 40)]
    aucs, p = cv_lr(Xs, yb, reps=2)
    assert aucs.mean() > 0.95, aucs
    lo, hi = boot_ci(yb, p, n=200)
    assert lo > 0.8
    aucs, _ = cv_lr(rng.normal(0, 1, (40, 2)), yb, reps=3)
    assert 0.2 < aucs.mean() < 0.8, aucs
    assert TinyCnn()(aug_maps(torch.zeros(3, 4, 100, 40))).shape == (3,)
    print("selfcheck OK")


if __name__ == "__main__":
    main()
