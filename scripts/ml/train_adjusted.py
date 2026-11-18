"""HbA1c > 7 % en la cohorte con features INVARIANTES a la adquisición y ajuste por centro.

Motivación (docs/arquitectura.md §8.5): la logística con TCI absoluto llegó a
AUC 0,64, igual que el centro de atención solo. Las temperaturas absolutas
dependen del centro y de la adquisición, así que el TCI medía condiciones de
adquisición. Aquí se repite la comparación sólo con features que no dependen
del nivel de temperatura (src/imaging/thermalPattern.js):
  - contralaterales: área con |ΔT| > 1 °C, |ΔT| medio y p95, diferencia de
    nivel entre pies, asimetría de patrón;
  - normalizadas por sujeto: T − mediana del pie por angiosoma y zona,
    dispersión; y su versión z (dividida por el rango intercuartil);
  - TCI «de patrón» contra el grupo control de la base pública (sin nivel).
Y se ajusta por centro de dos formas:
  - CV estratificada por desenlace × centro (los pliegues conservan la mezcla);
  - centro como covariable, comparado con el centro solo (¿qué agrega?);
  - AUC dentro de cada centro con casos suficientes (sin mezclar centros).

Además: el puntaje del modelo de patrón diabético (train_public.py) como
puntaje directo frente a HbA1c.

Desenlace: --outcome hba1c7 (por defecto) | lesion. Sólo agregados en la salida.
Uso: python -I scripts/ml/train_adjusted.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import argparse  # noqa: E402
import json  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.model_selection import StratifiedKFold  # noqa: E402

import common as C  # noqa: E402
from train_public import Prep, fit_lr, boot_ci, matrix, PATRON, CS  # noqa: E402

SETS = {
    "contralateral": ["areaCalientePct", "mediaAbs", "p95Abs", "difNivel", "asimPatron"],
    "normalizado": ["relMPA", "relLPA", "relMCA", "relLCA", "dedosRel", "talonRel", "iqr"],
    "normalizado_z": ["relMPAZ", "relLPAZ", "relMCAZ", "relLCAZ"],
    "invariante": PATRON,
}


def inner_c(X, y, strata, seed):
    k = min(5, int(min(np.bincount(y))))
    skf = StratifiedKFold(k, shuffle=True, random_state=seed)
    best, bc = -1, 0.5
    for c in CS:
        pr = np.zeros(len(y))
        for tr, te in skf.split(X, strata):
            if len(set(y[tr])) < 2:
                continue
            p, m = fit_lr(X[tr], y[tr], c)
            pr[te] = m.predict_proba(p(X[te]))[:, 1]
        a = roc_auc_score(y, pr)
        if a > best + 1e-9:
            best, bc = a, c
    return bc


def cv_lr(X, y, strata, reps=20, seed0=0):
    oof = np.zeros((reps, len(y)))
    aucs = []
    for r in range(reps):
        skf = StratifiedKFold(5, shuffle=True, random_state=seed0 + r)
        for tr, te in skf.split(X, strata):
            c = inner_c(X[tr], y[tr], strata[tr], seed0 + r)
            p, m = fit_lr(X[tr], y[tr], c)
            oof[r, te] = m.predict_proba(p(X[te]))[:, 1]
        aucs.append(roc_auc_score(y, oof[r]))
    return np.array(aucs), oof


def perm_within(X, y, strata, centro, observed, n=100, seed=0):
    """Permutación del desenlace DENTRO de cada centro (conserva la confusión por centro)."""
    rng = np.random.default_rng(seed)
    cnt = 0
    for k in range(n):
        yp = y.copy()
        for c in np.unique(centro):
            i = np.nonzero(centro == c)[0]
            yp[i] = rng.permutation(y[i])
        a, _ = cv_lr(X, yp, strata, reps=1, seed0=1000 + k)
        cnt += a.mean() >= observed
    return (cnt + 1) / (n + 1)


def within_auc(y, p, centro, min_cls=3):
    out = {}
    tot, acc = 0, 0.0
    for c in np.unique(centro):
        i = centro == c
        if min(int(y[i].sum()), int((1 - y[i]).sum())) < min_cls:
            continue
        a = roc_auc_score(y[i], p[i])
        out[str(c)] = {"n": int(i.sum()), "positivos": int(y[i].sum()), "auc": round(float(a), 3)}
        tot += i.sum()
        acc += a * i.sum()
    return out, (round(float(acc / tot), 3) if tot else None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outcome", default="hba1c7", choices=["hba1c7", "lesion"])
    args = ap.parse_args()
    t0 = time.time()
    rows = json.loads((C.DATA / "ml" / "pattern-cohorte.json").read_text(encoding="utf8"))
    sel = [r for r in rows if not r["noValido"] and r["desenlaces"][args.outcome] is not None]
    y = np.array([r["desenlaces"][args.outcome] for r in sel])
    res = {"desenlace": args.outcome, "generado": time.strftime("%Y-%m-%d"), "n": int(len(y)), "positivos": int(y.sum()), "modelos": []}
    print(f"desenlace {args.outcome}: n = {len(y)}, positivos = {int(y.sum())}")
    if min(int(y.sum()), int(len(y) - y.sum())) < 5:
        res["nota"] = "Menos de 5 casos en alguna clase: no se puede validar ningún modelo."
        print(res["nota"])
        (C.DATA / "ml" / f"adjusted-comparison-{args.outcome}.json").write_text(json.dumps(res, indent=2), encoding="utf8")
        return
    # Centro: Hospital Córdoba vs el resto (los otros dos centros son chicos).
    centro_nombre = np.array([r["centro"] for r in sel])
    hc = (centro_nombre == "Hospital Córdoba").astype(float)
    strata = y * 2 + hc.astype(int)
    res["porCentro"] = {str(c): {"n": int((centro_nombre == c).sum()), "positivos": int(y[centro_nombre == c].sum())}
                        for c in np.unique(centro_nombre)}

    def add(name, aucs, p, extra=None):
        d = {"modelo": name, "aucMedia": round(float(aucs.mean()), 3), "aucIC95": [round(v, 3) for v in boot_ci(y, p)]}
        w, wm = within_auc(y, np.atleast_2d(p).mean(0), centro_nombre)
        d["aucDentroDeCentro"] = w
        d["aucDentroPonderada"] = wm
        if extra:
            d.update(extra)
        res["modelos"].append(d)
        print(d, flush=True)

    add("control_centro", np.array([roc_auc_score(y, hc)]), hc, {"nota": "puntaje directo: Hospital Córdoba sí/no"})
    for name, keys in SETS.items():
        X = matrix(sel, keys)
        aucs, p = cv_lr(X, y, strata)
        extra = {"features": keys}
        if name == "invariante":
            extra["pPermutacionDentroDeCentro"] = round(perm_within(X, y, strata, centro_nombre, aucs.mean()), 3)
        add(name, aucs, p, extra)
        Xc = np.column_stack([X, hc])
        aucs, p = cv_lr(Xc, y, strata)
        add(f"{name}_mas_centro", aucs, p, {"features": keys + ["centro HC"]})

    tp = np.array([np.nan if r["tciPatron"] is None else r["tciPatron"] for r in sel])
    ok = np.isfinite(tp)
    add("tci_patron_directo", np.array([roc_auc_score(y[ok], tp[ok])]), np.where(ok, tp, np.nanmedian(tp)),
        {"nota": "TCI de patrón contra el grupo control público (sin nivel), puntaje directo"})
    ta = np.array([np.nan if r["tci"] is None else r["tci"] for r in sel])
    add("tci_absoluto_directo", np.array([roc_auc_score(y[ok], ta[ok])]), np.where(np.isfinite(ta), ta, np.nanmedian(ta)),
        {"nota": "TCI absoluto contra el grupo control público: depende del nivel (no invariante)"})

    fm = C.ROOT / "src" / "config" / "models" / "diabetic-pattern-logreg.json"
    if fm.exists():
        mod = json.loads(fm.read_text(encoding="utf8"))
        keys = [f["key"] for f in mod["features"]]
        X = matrix(sel, keys)
        for j, f in enumerate(mod["features"]):
            X[~np.isfinite(X[:, j]), j] = f["imputacion"]
        z = (X - np.array([f["media"] for f in mod["features"]])) / np.array([f["desvio"] for f in mod["features"]])
        s = 1 / (1 + np.exp(-(z @ np.array([f["coef"] for f in mod["features"]]) + mod["intercepto"])))
        add("patron_diabetico_directo", np.array([roc_auc_score(y, s)]), s,
            {"nota": "puntaje del modelo de patrón diabético (base pública), sin reentrenar"})

    res["segundos"] = round(time.time() - t0)
    (C.DATA / "ml" / f"adjusted-comparison-{args.outcome}.json").write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf8")
    print("listo", res["segundos"], "s")


if __name__ == "__main__":
    main()
