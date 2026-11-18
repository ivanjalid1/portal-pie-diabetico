"""Modelos ENTRENADOS con datos propios: factores de riesgo de úlcera desde el termograma.

La cohorte no tiene úlceras en el seguimiento (§8.8), pero la planilla registra
factores de riesgo de úlcera ESTABLECIDOS (estratificación IWGDF 2023, Bus et
al., doi:10.1002/dmrr.3651): neuropatía (LOPS), isquemia (EAP) y úlcera
previa. Isquemia y úlcera previa tienen 3 casos cada una, así que la etiqueta
principal, fijada de antemano, es la NEUROPATÍA. Secundarias (exploratorias):
IWGDF ≥ 1 (neuropatía, isquemia o úlcera previa), insulinorrequiriente y
diabetes de ≥ 10 años.

Modelos (lista fija; se informan TODOS):
  control_centro       Hospital Córdoba sí/no, puntaje directo
  control_edad         edad, puntaje directo
  control_anios_dm     años de diabetes, puntaje directo
  edad_lr              logística sobre edad + años de diabetes
  nivel_directo        temperatura mediana del pie (NO invariante: mide adquisición)
  contralateral_lr     área |ΔT| > 1 °C, |ΔT| medio y p95, diferencia de nivel,
                       asimetría de patrón, zona caliente contigua (punto a punto)
  angiosoma_lr         T − mediana del pie por angiosoma y zona, dispersión
  invariante_lr        las 13 invariantes del modelo público + zona caliente
  invariante_t12_lr    ídem, promediando toma 1 y toma 2 cuando hay dos
  invariante_edad_lr   invariantes + edad + años de diabetes (¿agrega a la clínica?)
  patron_dm_directo    puntaje del modelo de patrón diabético (base pública), sin reentrenar
  cnn                  CNN chica sobre los mapas relativos de ambos pies
  cnn_preentrenada     la misma CNN preentrenada en la base pública (diabetes vs
                       control) y ajustada en la cohorte

Validación (un paciente = una fila):
  - logísticas: 5 pliegues estratificados por etiqueta × centro, 20 repeticiones,
    C anidado, imputación y estandarización dentro del pliegue;
  - CNN: 5 × 4, hiperparámetros fijos;
  - AUC media con IC 95 % por bootstrap de pacientes;
  - AUC dentro de cada centro con ≥ 3 casos por clase y permutación de la
    etiqueta DENTRO de cada centro (conserva la confusión por centro);
  - sensibilidad: sólo Hospital Córdoba (entrenar y evaluar dentro del centro).
Regla para usar un modelo en el portal (fijada antes de correr): límite inferior
del IC > 0,5, permutación dentro de centro p < 0,05 y AUC dentro de centro > 0,5.

Uso: python -I scripts/ml/train_riskfactor.py [--label neuropatia] [--incluir-no-validos]
     [--no-cnn] [--export]
Salida: data-local/ml/riskfactor-<label>.json (sólo agregados). Con --export, el
modelo elegido va a data-local/models/riskfactor-<label>-logreg.json (deriva de
datos reales: no se versiona).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import argparse  # noqa: E402
import json  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.model_selection import StratifiedKFold  # noqa: E402

import common as C  # noqa: E402
from train_public import PATRON, NOMBRES, RelCnn, aug, boot_ci, fit_lr, matrix  # noqa: E402
from train_adjusted import cv_lr, inner_c, perm_within, within_auc  # noqa: E402

torch.set_num_threads(C.NUM_THREADS)

HOT = ["hotMax"]
SETS = {
    "contralateral_lr": ["areaCalientePct", "mediaAbs", "p95Abs", "difNivel", "asimPatron"] + HOT,
    "angiosoma_lr": ["relMPA", "relLPA", "relMCA", "relLCA", "dedosRel", "talonRel", "iqr", "rango90"],
    "invariante_lr": PATRON + HOT,
}
NOMBRES = {**NOMBRES, "hotMax": ("Mayor |ΔT| en zona caliente contigua", "°C"),
           "edad": ("Edad", "años"), "aniosDm": ("Años de diabetes", "años")}
LABELS = ["neuropatia", "iwgdf1", "insulina", "dm10"]


def feats_t12(rows, keys):
    """Promedio de las features de toma 1 y toma 2 (si hay toma 2 analizable)."""
    a = matrix(rows, keys)
    b = np.array([[np.nan if not r.get("features2") or r["features2"].get(k) is None else r["features2"][k]
                   for k in keys] for r in rows], dtype=float)
    return np.where(np.isfinite(b), (a + np.where(np.isfinite(b), b, 0)) / 2, a)


def cnn_fold(Mtr, ytr, Mte, seed, init=None, epochs=60, lr=3e-3):
    torch.manual_seed(seed)
    m = RelCnn()
    if init is not None:
        m.load_state_dict(init)
    opt = torch.optim.AdamW(m.parameters(), lr=lr, weight_decay=1e-3)
    pos = ytr.mean()
    pw = torch.tensor((1 - pos) / max(pos, 1e-3))
    X, Y = torch.from_numpy(Mtr), torch.from_numpy(ytr.astype(np.float32))
    for _ in range(epochs):
        m.train()
        perm = torch.randperm(len(X))
        for i in range(0, len(X), 8):
            idx = perm[i : i + 8]
            loss = F.binary_cross_entropy_with_logits(m(aug(X[idx])), Y[idx], pos_weight=pw)
            opt.zero_grad()
            loss.backward()
            opt.step()
    m.eval()
    with torch.no_grad():
        return torch.sigmoid(m(torch.from_numpy(Mte))).numpy()


def pretrain_public(sd):
    """CNN entrenada en TODA la base pública (diabetes vs control): no ve la cohorte."""
    M = np.load(C.DATA / "ml" / "pattern-public.npy").astype(np.float32)
    rows = json.loads((C.DATA / "ml" / "pattern-public.json").read_text(encoding="utf8"))
    y = np.array([r["dm"] for r in rows])
    M[:, :2] /= sd
    torch.manual_seed(0)
    m = RelCnn()
    opt = torch.optim.AdamW(m.parameters(), lr=3e-3, weight_decay=1e-3)
    pw = torch.tensor((1 - y.mean()) / y.mean())
    X, Y = torch.from_numpy(M), torch.from_numpy(y.astype(np.float32))
    for _ in range(60):
        m.train()
        perm = torch.randperm(len(X))
        for i in range(0, len(X), 8):
            idx = perm[i : i + 8]
            loss = F.binary_cross_entropy_with_logits(m(aug(X[idx])), Y[idx], pos_weight=pw)
            opt.zero_grad()
            loss.backward()
            opt.step()
    return {k: v.clone() for k, v in m.state_dict().items()}


def cv_cnn(M, y, strata, reps=4, pre=None):
    oof = np.zeros((reps, len(y)))
    aucs = []
    sd = float(np.std(M[:, :2][M[:, :2] != 0])) or 1.0
    Ms = M.copy()
    Ms[:, :2] /= sd
    for r in range(reps):
        skf = StratifiedKFold(5, shuffle=True, random_state=r)
        for tr, te in skf.split(Ms, strata):
            if pre is None:
                oof[r, te] = cnn_fold(Ms[tr], y[tr], Ms[te], r)
            else:
                oof[r, te] = cnn_fold(Ms[tr], y[tr], Ms[te], r, init=pre, epochs=30, lr=1e-3)
        aucs.append(roc_auc_score(y, oof[r]))
        print(f"  cnn{'-pre' if pre else ''} repetición {r + 1}/{reps}: AUC {aucs[-1]:.3f}", flush=True)
    return np.array(aucs), oof


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="neuropatia", choices=LABELS)
    ap.add_argument("--incluir-no-validos", action="store_true")
    ap.add_argument("--no-cnn", action="store_true")
    ap.add_argument("--perms", type=int, default=200)
    ap.add_argument("--export", action="store_true")
    args = ap.parse_args()
    t0 = time.time()
    rows = json.loads((C.DATA / "ml" / "pattern-cohorte.json").read_text(encoding="utf8"))
    Mall = np.load(C.DATA / "ml" / "pattern-cohorte.npy").astype(np.float32)
    idx = [i for i, r in enumerate(rows)
           if (args.incluir_no_validos or not r["noValido"]) and r["desenlaces"].get(args.label) is not None]
    sel = [rows[i] for i in idx]
    M = Mall[idx]
    y = np.array([r["desenlaces"][args.label] for r in sel])
    centro = np.array([r["centro"] for r in sel])
    hc = (centro == "Hospital Córdoba").astype(int)
    strata = y * 2 + hc
    tag = args.label + ("-todos" if args.incluir_no_validos else "")
    res = {"etiqueta": args.label, "muestra": "incluye «no válidos»" if args.incluir_no_validos else "válidos",
           "generado": time.strftime("%Y-%m-%d"), "n": int(len(y)), "positivos": int(y.sum()),
           "porCentro": {str(c): {"n": int((centro == c).sum()), "positivos": int(y[centro == c].sum())}
                         for c in np.unique(centro)},
           "modelos": []}
    print(f"{tag}: n = {len(y)}, positivos = {int(y.sum())}; por centro {res['porCentro']}", flush=True)
    cov = lambda k: np.array([np.nan if r["covariables"][k] is None else r["covariables"][k] for r in sel], float)  # noqa: E731
    edad, anios = cov("edad"), cov("aniosDm")

    def add(name, aucs, p, extra=None):
        P = np.atleast_2d(p)
        d = {"modelo": name, "aucMedia": round(float(np.mean(aucs)), 3),
             "aucIC95": [round(v, 3) for v in boot_ci(y, P)]}
        w, wm = within_auc(y, P.mean(0), centro)
        d["aucDentroDeCentro"] = w
        d["aucDentroPonderada"] = wm
        if extra:
            d.update(extra)
        res["modelos"].append(d)
        print({k: v for k, v in d.items() if k != "features"}, flush=True)
        return d

    def direct(name, v, nota):
        v = np.where(np.isfinite(v), v, np.nanmedian(v))
        add(name, np.array([roc_auc_score(y, v)]), v, {"nota": nota})

    direct("control_centro", hc.astype(float), "Hospital Córdoba sí/no (confusor)")
    direct("control_edad", edad, "edad sola (confusor clínico)")
    direct("control_anios_dm", anios, "años de diabetes solos")
    Xc = np.column_stack([edad, anios])
    a, p = cv_lr(Xc, y, strata)
    add("edad_lr", a, p, {"features": ["edad", "aniosDm"]})
    direct("nivel_directo", matrix(sel, ["nivel"])[:, 0], "temperatura absoluta: depende de cámara y centro")

    best = None
    for name, keys in SETS.items():
        X = matrix(sel, keys)
        a, p = cv_lr(X, y, strata)
        extra = {"features": keys}
        if args.perms:
            extra["pPermutacionDentroDeCentro"] = round(perm_within(X, y, strata, centro, a.mean(), n=args.perms), 4)
        d = add(name, a, p, extra)
        if name == "invariante_lr":
            best = (keys, X, d, p)
    keys = SETS["invariante_lr"]
    X12 = feats_t12(sel, keys)
    a, p = cv_lr(X12, y, strata)
    add("invariante_t12_lr", a, p, {"features": keys, "nota": "promedio de toma 1 y toma 2 cuando hay dos",
                                     "pPermutacionDentroDeCentro": round(perm_within(X12, y, strata, centro, a.mean(), n=args.perms), 4)
                                     if args.perms else None})
    Xe = np.column_stack([best[1], edad, anios])
    a, p = cv_lr(Xe, y, strata)
    add("invariante_edad_lr", a, p, {"features": keys + ["edad", "aniosDm"]})

    fm = C.ROOT / "src" / "config" / "models" / "diabetic-pattern-logreg.json"
    if fm.exists():
        mod = json.loads(fm.read_text(encoding="utf8"))
        k2 = [f["key"] for f in mod["features"]]
        X = matrix(sel, k2)
        for j, f in enumerate(mod["features"]):
            X[~np.isfinite(X[:, j]), j] = f["imputacion"]
        z = (X - np.array([f["media"] for f in mod["features"]])) / np.array([f["desvio"] for f in mod["features"]])
        s = 1 / (1 + np.exp(-(z @ np.array([f["coef"] for f in mod["features"]]) + mod["intercepto"])))
        direct("patron_dm_directo", s, "modelo de patrón diabético (base pública), sin reentrenar")

    if not args.no_cnn:
        a, p = cv_cnn(M, y, strata)
        add("cnn", a, p, {"entrada": "mapas 3×100×40 (T − mediana de cada pie, máscara)"})
        sd = float(np.std(M[:, :2][M[:, :2] != 0])) or 1.0
        pre = pretrain_public(sd)
        a, p = cv_cnn(M, y, strata, pre=pre)
        add("cnn_preentrenada", a, p, {"entrada": "ídem; preentrenada en la base pública (diabetes vs control)"})

    # Sensibilidad: sólo Hospital Córdoba (sin mezclar centros).
    i = hc == 1
    if min(int(y[i].sum()), int((1 - y[i]).sum())) >= 5:
        Xh = best[1][i]
        a, p = cv_lr(Xh, y[i], y[i])
        ci = boot_ci(y[i], p)
        res["soloHospitalCordoba"] = {"modelo": "invariante_lr", "n": int(i.sum()), "positivos": int(y[i].sum()),
                                      "aucMedia": round(float(a.mean()), 3), "aucIC95": [round(v, 3) for v in ci]}
        print("solo HC:", res["soloHospitalCordoba"], flush=True)

    nmod = len(res["modelos"]) - 3  # sin contar los tres controles directos
    res["variantesProbadas"] = nmod
    d = best[2]
    regla = (d["aucIC95"][0] > 0.5 and (d.get("pPermutacionDentroDeCentro") or 1) < 0.05
             and (d["aucDentroPonderada"] or 0) > 0.5)
    res["regla"] = {"modelo": "invariante_lr", "cumple": bool(regla),
                    "criterio": "IC inferior > 0,5, permutación dentro de centro p < 0,05 y AUC dentro de centro > 0,5 (fijado de antemano)"}
    res["segundos"] = round(time.time() - t0)
    out = C.DATA / "ml" / f"riskfactor-{tag}.json"
    out.write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf8")
    print("regla:", res["regla"], "| variantes:", nmod, "| listo", res["segundos"], "s", flush=True)

    if args.export:
        if not regla:
            print("El modelo no cumple la regla: no se exporta.")
            sys.exit(2)
        X = best[1]
        c = inner_c(X, y, strata, 0)
        prep, m = fit_lr(X, y, c)
        r4 = lambda v: round(float(v), 4)  # noqa: E731
        model = {
            "_descripcion": f"Regresión logística L2 que estima la probabilidad de {args.label} desde features térmicas invariantes de la toma 1. Entrenada con la cohorte propia (scripts/ml/train_riskfactor.py). Deriva de datos reales: no se versiona.",
            "version": f"riesgo-{args.label}-v1",
            "generado": res["generado"],
            "etiqueta": args.label,
            "C": c,
            "intercepto": r4(m.intercept_[0]),
            "features": [{"key": k, "nombre": NOMBRES[k][0], "unidad": NOMBRES[k][1], "media": r4(prep.sc.mean_[j]),
                          "desvio": r4(prep.sc.scale_[j]), "imputacion": r4(prep.mu[j]), "coef": r4(m.coef_[0][j])}
                         for j, k in enumerate(best[0])],
            "validacion": {"metodo": "5 pliegues estratificados por etiqueta × centro, 20 repeticiones, C anidado",
                           "n": res["n"], "positivos": res["positivos"], "auc": d["aucMedia"], "aucIC95": d["aucIC95"],
                           "aucDentroDeCentro": d["aucDentroPonderada"],
                           "pPermutacionDentroDeCentro": d.get("pPermutacionDentroDeCentro"),
                           "variantesProbadas": nmod},
        }
        dest = C.MODELS / f"riskfactor-{args.label}-logreg.json"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(model, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
        print("modelo exportado:", dest.relative_to(C.ROOT))


if __name__ == "__main__":
    main()
