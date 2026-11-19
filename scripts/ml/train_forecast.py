"""Pronóstico de la evolución térmica por zona (toma 1 → toma 2).

Entrada (scripts/ml/export-forecast.js, en data-local/ml/forecast/):
  pairs.f32 + pairs-meta.json   pares toma 1 / toma 2 y variables por pie × zona
  retest-zones.json             (opcional) réplicas de una misma toma: ruido test-retest

Unidad: pie × zona (dedos, metatarso, arco, talón). Variables por zona (las de
src/services/ThermalForecastService.js):
  área caliente  % de celdas de la zona en las que ESE pie está > 1 °C más
                 caliente que el mismo punto del pie contralateral;
  ΔT orientado   media de (este pie − contralateral) en la zona, °C.

Modelos (se entrenan con TODOS los pares y se validan con CV por paciente:
GroupKFold 5, 10 repeticiones con los pacientes barajados):
  area     área t2 = a + b · área t1 (regresión a la media). Rango 80 %:
           percentiles 10 y 90 de los residuos fuera de pliegue.
  dT       ΔT t2 = a + b · ΔT t1, ídem.
  planta   % de la planta con |ΔT| > 1 °C (la serie del gráfico de evolución), ídem.
  prob     P(zona ≥ 10 % de área caliente en t2): logística sobre área t1 / 10 y
           ΔT t1. Se recalibra con la pendiente y el intercepto de calibración de
           la CV (logit de las predicciones fuera de pliegue).
  pixel    mapa de ΔT esperado = β · ΔT t1 (encogimiento; β por mínimos cuadrados).
Comparadores: persistencia (t2 = t1) y la media del entrenamiento.

Salida: data-local/models/forecast-zones.json con coeficientes y métricas de CV.
Sólo números agregados: ningún dato de paciente. No se versiona.

Uso: python -I scripts/ml/train_forecast.py
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import numpy as np
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score
from sklearn.model_selection import GroupKFold

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[2]
D = ROOT / "data-local" / "ml" / "forecast"
OUT = ROOT / "data-local" / "models" / "forecast-zones.json"
ZONAS = [("dedos", 0, 20), ("metatarso", 20, 42), ("arco", 42, 70), ("talon", 70, 100)]
PIES = ("izq", "der")
AREA_UMBRAL = 10.0  # % de la zona (el «área mínima» por defecto del portal)
EMPEORA_PP = 10.0
REPS = 10
rng = np.random.default_rng(0)

meta = json.loads((D / "pairs-meta.json").read_text(encoding="utf8"))
M = meta["meta"]
UMBRAL = meta["umbralPixel"]
n_pares = len(M)

# ---------------- Filas pie × zona ----------------
rows = []
for m in M:
    t1, t2 = m["tomas"]
    for pie in PIES:
        for z, _, _ in ZONAS:
            a, b = t1["zonas"][pie][z], t2["zonas"][pie][z]
            if a is None or b is None:
                continue
            rows.append((m["i"], m["centro"], a["areaPct"], b["areaPct"], a["dT"], b["dT"]))
R = np.array(rows, dtype=float)
g, cen = R[:, 0].astype(int), R[:, 1].astype(int)
h1, h2, d1, d2 = R[:, 2], R[:, 3], R[:, 4], R[:, 5]
print(f"pares {n_pares} · filas pie-zona comparables {len(R)} · pacientes {len(np.unique(g))}")

pl = np.array([(m["i"], m["tomas"][0]["plantaPct"], m["tomas"][1]["plantaPct"]) for m in M
               if m["tomas"][0]["plantaPct"] is not None and m["tomas"][1]["plantaPct"] is not None], dtype=float)


def folds(groups, rep_seed):
    """GroupKFold(5) con los pacientes barajados (una repetición)."""
    uniq = np.unique(groups)
    perm = np.random.default_rng(rep_seed).permutation(len(uniq))
    lab = perm[np.searchsorted(uniq, groups)]
    return list(GroupKFold(5).split(groups, groups, lab))


def cv_linear(x, y, groups):
    """Regresión a la media vs persistencia vs media: MAE por repetición, residuos fuera de pliegue, cobertura 80 %."""
    mae = {"modelo": [], "persistencia": [], "media": []}
    res_all, cover = [], []
    for rep in range(REPS):
        p = np.full(len(y), np.nan)
        pm = np.full(len(y), np.nan)
        hit = np.zeros(len(y), bool)
        for tr, te in folds(groups, rep):
            lr = LinearRegression().fit(x[tr, None], y[tr])
            p[te] = lr.predict(x[te, None])
            pm[te] = y[tr].mean()
            # Rango 80 % dentro del pliegue: percentiles de los residuos del entrenamiento.
            r_tr = y[tr] - lr.predict(x[tr, None])
            lo, hi = np.percentile(r_tr, [10, 90])
            hit[te] = (y[te] >= p[te] + lo) & (y[te] <= p[te] + hi)
        mae["modelo"].append(np.mean(np.abs(p - y)))
        mae["persistencia"].append(np.mean(np.abs(x - y)))
        mae["media"].append(np.mean(np.abs(pm - y)))
        res_all.append(y - p)
        cover.append(hit.mean())
    res = np.concatenate(res_all)
    lr = LinearRegression().fit(x[:, None], y)
    lo, hi = np.percentile(res, [10, 90])
    return {
        "intercepto": float(lr.intercept_),
        "pendiente": float(lr.coef_[0]),
        "rango80": [float(lo), float(hi)],
        "cv": {
            "mae": float(np.mean(mae["modelo"])),
            "maeSd": float(np.std(mae["modelo"])),
            "maePersistencia": float(np.mean(mae["persistencia"])),
            "maeMedia": float(np.mean(mae["media"])),
            "cobertura80": float(np.mean(cover)),
            "correlacionT1T2": float(np.corrcoef(x, y)[0, 1]),
            "n": int(len(y)),
        },
    }


def boot_auc(y, s, groups, B=1000):
    pats = np.unique(groups)
    idx = {p: np.where(groups == p)[0] for p in pats}
    vals = []
    for _ in range(B):
        k = np.concatenate([idx[p] for p in rng.choice(pats, len(pats))])
        if y[k].min() != y[k].max():
            vals.append(roc_auc_score(y[k], s[k]))
    return [float(v) for v in np.percentile(vals, [2.5, 97.5])]


def within_center(y, s):
    w = [(np.sum(cen == c), roc_auc_score(y[cen == c], s[cen == c])) for c in np.unique(cen)
         if y[cen == c].min() != y[cen == c].max()]
    return float(sum(a * b for a, b in w) / sum(a for a, _ in w))


def logit(p):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


def cv_logistic(y, A):
    aucs, oof = [], []
    for rep in range(REPS):
        p = np.full(len(y), np.nan)
        for tr, te in folds(g, rep):
            p[te] = LogisticRegression(C=1.0, max_iter=2000).fit(A[tr], y[tr]).predict_proba(A[te])[:, 1]
        aucs.append(roc_auc_score(y, p))
        oof.append(p)
    P = np.mean(oof, 0)
    return float(np.mean(aucs)), P


# ---------------- Regresiones ----------------
area = cv_linear(h1, h2, g)
dT = cv_linear(d1, d2, g)
planta = cv_linear(pl[:, 1], pl[:, 2], pl[:, 0].astype(int))
for nm, r in (("área caliente (pp)", area), ("ΔT orientado (°C)", dT), ("planta (pp)", planta)):
    c = r["cv"]
    print(f"{nm:20s} MAE {c['mae']:.3f} (persistencia {c['maePersistencia']:.3f}, media {c['maeMedia']:.3f}); "
          f"t2 = {r['intercepto']:.2f} + {r['pendiente']:.3f}·t1; rango 80 % [{r['rango80'][0]:+.2f}, {r['rango80'][1]:+.2f}], "
          f"cobertura CV {c['cobertura80']:.2f}; r {c['correlacionT1T2']:.2f}; n {c['n']}")

# ---------------- P(zona ≥ 10 % en t2) ----------------
y = (h2 >= AREA_UMBRAL).astype(int)
A = np.column_stack([h1 / 10, d1])
auc, P = cv_logistic(y, A)
ci = boot_auc(y, P, g)
auc_pers = float(roc_auc_score(y, h1))
ci_pers = boot_auc(y, h1, g)
cal = LogisticRegression(C=1e6, max_iter=2000).fit(logit(P)[:, None], y)
cal_slope, cal_int = float(cal.coef_[0, 0]), float(cal.intercept_[0])
P_cal = 1 / (1 + np.exp(-(cal_int + cal_slope * logit(P))))
final = LogisticRegression(C=1.0, max_iter=2000).fit(A, y)
prob = {
    "intercepto": float(final.intercept_[0]),
    "coefArea": float(final.coef_[0, 0]),
    "coefDT": float(final.coef_[0, 1]),
    "calibracion": {"intercepto": cal_int, "pendiente": cal_slope},
    "cv": {
        "auc": auc,
        "aucIC95": ci,
        "aucDentroDeCentro": within_center(y, P),
        "aucPersistencia": auc_pers,
        "aucPersistenciaIC95": ci_pers,
        "pendienteCalibracion": cal_slope,
        "interceptoCalibracion": cal_int,
        "brier": float(brier_score_loss(y, P)),
        "brierRecalibrado": float(brier_score_loss(y, P_cal)),
        "brierPrevalencia": float(y.mean() * (1 - y.mean())),
        "prevalencia": float(y.mean()),
        "n": int(len(y)),
        "positivos": int(y.sum()),
        "transiciones": {
            "siguenCalientes": int(((h1 >= AREA_UMBRAL) & (h2 >= AREA_UMBRAL)).sum()),
            "resuelven": int(((h1 >= AREA_UMBRAL) & (h2 < AREA_UMBRAL)).sum()),
            "nuevas": int(((h1 < AREA_UMBRAL) & (h2 >= AREA_UMBRAL)).sum()),
            "siguenNormales": int(((h1 < AREA_UMBRAL) & (h2 < AREA_UMBRAL)).sum()),
        },
    },
}
c = prob["cv"]
print(f"P(zona ≥ {AREA_UMBRAL:.0f} % en t2): prevalencia {c['prevalencia']:.3f}; logística AUC {c['auc']:.3f} "
      f"(IC {ci[0]:.2f}–{ci[1]:.2f}), dentro de centro {c['aucDentroDeCentro']:.3f}; persistencia AUC {auc_pers:.3f} "
      f"(IC {ci_pers[0]:.2f}–{ci_pers[1]:.2f}); calibración pendiente {cal_slope:.2f}, intercepto {cal_int:+.2f}; "
      f"Brier {c['brier']:.3f} (prevalencia {c['brierPrevalencia']:.3f}); transiciones {c['transiciones']}")

yw = ((h2 - h1) > EMPEORA_PP).astype(int)
auc_w, Pw = cv_logistic(yw, A)
empeora = {"definicion": f"área t2 − t1 > {EMPEORA_PP:.0f} pp", "auc": auc_w, "aucIC95": boot_auc(yw, Pw, g),
           "prevalencia": float(yw.mean()), "positivos": int(yw.sum())}
print(f"empeora (> +{EMPEORA_PP:.0f} pp): prevalencia {yw.mean():.3f}; AUC {auc_w:.3f} "
      f"(IC {empeora['aucIC95'][0]:.2f}–{empeora['aucIC95'][1]:.2f})")

# ---------------- Mapa por punto: β · ΔT t1 ----------------
X = np.fromfile(D / "pairs.f32", dtype=np.float32).reshape(meta["shape"])
rows_zone = np.empty(100, dtype=object)
for z, a, b in ZONAS:
    rows_zone[a:b] = z
dts = []
for m, x in zip(M, X):
    pair = []
    for k in range(2):
        dt = (x[k, 0] - x[k, 1]).astype(np.float64)
        for z in m["tomas"][k]["excluidas"]:
            dt[rows_zone == z] = np.nan
        pair.append(dt)
    dts.append(pair)
dts = np.array(dts)  # n, 2, 100, 40
ok = np.isfinite(dts[:, 0]) & np.isfinite(dts[:, 1])
pix = {"modelo": [], "persistencia": [], "cero": []}
for rep in range(REPS):
    e_m, e_p, e_0, cnt = 0.0, 0.0, 0.0, 0
    for tr, te in folds(np.arange(n_pares), rep):
        a, b = dts[tr, 0][ok[tr]], dts[tr, 1][ok[tr]]
        beta = float((a * b).sum() / (a * a).sum())
        ta, tb = dts[te, 0][ok[te]], dts[te, 1][ok[te]]
        e_m += np.abs(beta * ta - tb).sum(); e_p += np.abs(ta - tb).sum(); e_0 += np.abs(tb).sum(); cnt += ta.size
    pix["modelo"].append(e_m / cnt); pix["persistencia"].append(e_p / cnt); pix["cero"].append(e_0 / cnt)
a, b = dts[:, 0][ok], dts[:, 1][ok]
beta = float((a * b).sum() / (a * a).sum())
pixel = {"beta": beta, "cv": {"mae": float(np.mean(pix["modelo"])), "maePersistencia": float(np.mean(pix["persistencia"])),
                              "maeCero": float(np.mean(pix["cero"])), "celdas": int(ok.sum())}}
print(f"mapa ΔT por punto: β {beta:.3f}; MAE β·ΔT1 {pixel['cv']['mae']:.3f} °C, persistencia "
      f"{pixel['cv']['maePersistencia']:.3f}, cero {pixel['cv']['maeCero']:.3f}")

# ---------------- Horizonte ----------------
dias = np.array([m["dias"] for m in M if not m["estimada"] and m["dias"] is not None], dtype=float)
horizonte = {"mediana": int(np.median(dias)), "p25": int(np.percentile(dias, 25)), "p75": int(np.percentile(dias, 75)),
             "min": int(dias.min()), "max": int(dias.max()), "n": int(len(dias)),
             "estimadas": int(sum(1 for m in M if m["estimada"]))}
print(f"días entre tomas (fechas registradas): mediana {horizonte['mediana']} (p25–p75 {horizonte['p25']}–{horizonte['p75']}), n {len(dias)}")

# ---------------- Test-retest ----------------
retest = None
rt = D / "retest-zones.json"
if rt.exists():
    T = json.loads(rt.read_text(encoding="utf8"))
    ha, hb, da_, db_ = [], [], [], []
    for p in T["pares"]:
        for pie in PIES:
            for z, _, _ in ZONAS:
                u, v = p["a"][pie][z], p["b"][pie][z]
                if u is None or v is None:
                    continue
                ha.append(u["areaPct"]); hb.append(v["areaPct"]); da_.append(u["dT"]); db_.append(v["dT"])
    ha, hb, da_, db_ = map(np.array, (ha, hb, da_, db_))
    dh = ha - hb
    oa, ob = ha >= AREA_UMBRAL, hb >= AREA_UMBRAL
    po = np.mean(oa == ob)
    pe = oa.mean() * ob.mean() + (1 - oa.mean()) * (1 - ob.mean())
    pm = np.array([p["pixelMae"] for p in T["pares"] if p["pixelMae"] is not None])
    retest = {
        "sesiones": T["sesiones"], "paresReplicas": len(T["pares"]), "paresZona": int(len(dh)),
        "areaAbsMedia": float(np.mean(np.abs(dh))), "areaAbsMediana": float(np.median(np.abs(dh))),
        "areaAbsP90": float(np.percentile(np.abs(dh), 90)), "areaSdDif": float(np.std(dh)),
        # Cambio mínimo detectable (95 %) entre dos mediciones: 1,96 · DE de la diferencia entre réplicas.
        "areaCmd95": float(1.96 * np.std(dh)),
        "areaCorrelacion": float(np.corrcoef(ha, hb)[0, 1]),
        "kappaZonaCaliente": float((po - pe) / (1 - pe)),
        "dTAbsMedia": float(np.mean(np.abs(da_ - db_))),
        "pixelMae": float(np.mean(pm)),
    }
    print(f"test-retest: {retest['sesiones']} sesiones; |Δ área| media {retest['areaAbsMedia']:.2f} pp "
          f"(mediana {retest['areaAbsMediana']:.1f}, p90 {retest['areaAbsP90']:.1f}, CMD95 {retest['areaCmd95']:.1f}); "
          f"r {retest['areaCorrelacion']:.2f}; kappa ≥10 % {retest['kappaZonaCaliente']:.2f}; |Δ ΔT zonal| "
          f"{retest['dTAbsMedia']:.3f} °C; ΔT por punto MAE {retest['pixelMae']:.3f} °C")

model = {
    "version": "pronostico-zonas-v1",
    "generado": date.today().isoformat(),
    "descripcion": "Pronóstico por pie × zona del próximo control desde la última toma (regresión a la media, "
                   "logística recalibrada y encogimiento por punto). Sólo coeficientes y métricas de CV.",
    "umbralPixel": UMBRAL,
    "areaUmbral": AREA_UMBRAL,
    "horizonteDias": horizonte,
    "n": {"pares": n_pares, "filasPieZona": int(len(R)), "pacientes": int(len(np.unique(g)))},
    "validacion": f"GroupKFold 5 por paciente × {REPS} repeticiones; IC 95 % por bootstrap de pacientes",
    "area": area,
    "dT": dT,
    "planta": planta,
    "prob": prob,
    "empeora": empeora,
    "pixel": pixel,
    "retest": retest,
}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(model, indent=1, ensure_ascii=False), encoding="utf8")
print(f"modelo → {OUT.relative_to(ROOT)}")
