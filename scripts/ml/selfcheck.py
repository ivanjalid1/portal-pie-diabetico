"""Autocomprobación rápida de los scripts de ML con datos SINTÉTICOS (sin datos reales).

Uso: python -I scripts/ml/selfcheck.py
"""
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import torch  # noqa: E402

import common as C  # noqa: E402
from segment_unet import flags, postprocess  # noqa: E402
from train_models import TinyCnn, aug_maps, boot_ci, cv_lr  # noqa: E402
from train_public import Prep, RelCnn  # noqa: E402
from train_unet import UNet, augment  # noqa: E402


def check_train_outcome():
    """train-outcome.py se niega a entrenar con pocos casos y prioriza el portal sobre la planilla."""
    spec = importlib.util.spec_from_file_location("train_outcome", Path(__file__).resolve().parent / "train-outcome.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        rows = [{"grupo": f"P{i}", "noValido": False, "features": {k: float(i) for k in mod.FEATURES}} for i in range(30)]
        (d / "f.json").write_text(json.dumps(rows), encoding="utf8")
        (d / "ds.json").write_text(json.dumps({"pacientes": [{"codigo": "P1", "clinica": {"generoLesion": True}}]}), encoding="utf8")
        regs = [{"codigo": f"P{i}", "generoLesion": i < 3} for i in range(25)]
        (d / "o.json").write_text(json.dumps({"registros": regs}), encoding="utf8")
        out = mod.load_outcomes(d / "o.json", d / "ds.json")
        assert out["P1"] == (1, "portal")
        args = ["--features", str(d / "f.json"), "--dataset", str(d / "ds.json"), "--outcomes", str(d / "o.json")]
        assert mod.main(args) == 2, "debía negarse con 3 lesiones"
        assert mod.main(args + ["--min-positivos", "3", "--dry-run"]) == 0


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
    assert RelCnn()(torch.zeros(2, 3, 100, 40)).shape == (2,)
    # Imputación por la media del entrenamiento.
    Xn = np.array([[1.0, np.nan], [3.0, 2.0], [np.nan, 4.0]])
    pr = Prep().fit(Xn)
    assert np.allclose(pr.fill(Xn), [[1, 3], [3, 2], [2, 4]])
    check_train_outcome()
    print("selfcheck OK")


if __name__ == "__main__":
    main()
