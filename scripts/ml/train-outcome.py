"""Modelo de ÚLCERA REAL (lesión en el seguimiento), sólo cuando haya casos suficientes.

Fuentes del desenlace (no se inventa ninguno):
  1. data-local/outcomes/outcomes.json: el «Desenlace real» que registra el
     médico en el portal (src/services/OutcomeLog.js). Tiene prioridad.
  2. La columna «generó lesión» de la planilla clínica (data-local/real/dataset.json),
     si el portal no tiene registro para ese paciente.
Features: las invariantes a la adquisición de la toma 1 (data-local/ml/pattern-cohorte.json,
scripts/ml/export-pattern-features.js).

Se NIEGA a entrenar (código de salida 2) si hay menos de --min-positivos
lesiones (10 por defecto) o menos de --min-negativos sin lesión (10), entre
los pacientes con features y sin la marca «no válido». Con datos suficientes:
logística L2, 5 pliegues estratificados por paciente × 20 repeticiones con C
anidado, IC 95 % por bootstrap y test de permutación; exporta sólo
coeficientes y métricas agregadas a src/config/models/outcome-logreg.json.

Uso: python -I scripts/ml/train-outcome.py [--min-positivos 10] [--min-negativos 10] [--dry-run]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import argparse  # noqa: E402
import json  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

import common as C  # noqa: E402

FEATURES = ["relMPA", "relLPA", "relMCA", "relLCA", "dedosRel", "talonRel", "iqr",
            "difNivel", "asimPatron", "areaCalientePct", "mediaAbs", "p95Abs"]


def load_outcomes(outcomes_file, dataset_file):
    """código → (lesión 0/1, fuente). El portal tiene prioridad sobre la planilla."""
    out = {}
    if dataset_file.exists():
        for p in json.loads(dataset_file.read_text(encoding="utf8")).get("pacientes", []):
            v = (p.get("clinica") or {}).get("generoLesion")
            if v is not None:
                out[p["codigo"]] = (1 if v else 0, "planilla")
    if outcomes_file.exists():
        for r in json.loads(outcomes_file.read_text(encoding="utf8")).get("registros", []):
            if r.get("generoLesion") is not None:
                out[r["codigo"]] = (1 if r["generoLesion"] else 0, "portal")
    return out


def build_sample(rows, outcomes):
    sel, y, fuentes = [], [], {"portal": 0, "planilla": 0}
    for r in rows:
        if r.get("noValido") or r["grupo"] not in outcomes:
            continue
        v, src = outcomes[r["grupo"]]
        sel.append(r)
        y.append(v)
        fuentes[src] += 1
    return sel, np.array(y, dtype=int), fuentes


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-positivos", type=int, default=10)
    ap.add_argument("--min-negativos", type=int, default=10)
    ap.add_argument("--outcomes", default=str(C.DATA / "outcomes" / "outcomes.json"))
    ap.add_argument("--dataset", default=str(C.DATA / "real" / "dataset.json"))
    ap.add_argument("--features", default=str(C.DATA / "ml" / "pattern-cohorte.json"))
    ap.add_argument("--dry-run", action="store_true", help="sólo cuenta casos, no entrena")
    args = ap.parse_args(argv)
    fpath = Path(args.features)
    if not fpath.exists():
        print("Faltan las features (node scripts/ml/export-pattern-features.js).")
        return 1
    rows = json.loads(fpath.read_text(encoding="utf8"))
    outcomes = load_outcomes(Path(args.outcomes), Path(args.dataset))
    sel, y, fuentes = build_sample(rows, outcomes)
    pos, neg = int(y.sum()), int(len(y) - y.sum())
    print(f"pacientes con desenlace y features: {len(y)} (lesión: {pos}, sin lesión: {neg}; "
          f"registrados en el portal: {fuentes['portal']}, de la planilla: {fuentes['planilla']})")
    if pos < args.min_positivos or neg < args.min_negativos:
        print(f"NO SE ENTRENA: se necesitan al menos {args.min_positivos} lesiones y {args.min_negativos} "
              f"pacientes sin lesión. Registrá el «Desenlace real» de cada paciente en el portal y volvé a correr.")
        return 2
    if args.dry_run:
        print("Hay casos suficientes (--dry-run: no se entrena).")
        return 0

    from train_public import cv_lr, boot_ci, perm_test, inner_c, fit_lr, matrix  # noqa: E402

    X = matrix(sel, FEATURES)
    aucs, oof = cv_lr(X, y)
    ci = boot_ci(y, oof)
    pv = perm_test(X, y, aucs.mean())
    c = inner_c(X, y, 0)
    prep, m = fit_lr(X, y, c)
    r4 = lambda v: round(float(v), 4)  # noqa: E731
    out = {
        "_descripcion": "Modelo de LESIÓN en el seguimiento (regresión logística L2) sobre features invariantes de la toma 1. Generado por scripts/ml/train-outcome.py con desenlaces reales registrados; sólo parámetros y métricas agregadas.",
        "version": "lesion-logreg-v1",
        "generado": time.strftime("%Y-%m-%d"),
        "desenlace": "Lesión en el seguimiento (Desenlace real)",
        "C": c,
        "intercepto": r4(m.intercept_[0]),
        "features": [
            {"key": k, "media": r4(prep.sc.mean_[j]), "desvio": r4(prep.sc.scale_[j]), "imputacion": r4(prep.mu[j]),
             "coef": r4(m.coef_[0][j])}
            for j, k in enumerate(FEATURES)
        ],
        "validacion": {
            "metodo": "5 pliegues estratificados por paciente × 20 repeticiones, C anidado",
            "n": int(len(y)), "positivos": pos, "auc": round(float(aucs.mean()), 3),
            "aucIC95": [round(v, 3) for v in ci], "pPermutacion": round(pv, 4),
            "fuentes": fuentes,
        },
    }
    dest = C.ROOT / "src" / "config" / "models" / "outcome-logreg.json"
    dest.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf8", newline="\n")
    print(f"AUC {out['validacion']['auc']} (IC 95 % {out['validacion']['aucIC95']}), p perm. {pv:.4f}")
    print(f"modelo exportado: {dest.relative_to(C.ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
