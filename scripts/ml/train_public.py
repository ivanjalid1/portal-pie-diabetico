"""Modelo con etiqueta REAL: diabetes (DM) vs control (CG) en la base pública 2019.

Base: Hernández-Contreras et al. 2019, «Plantar Thermogram Database for the
Study of Diabetic Foot Complications» (IEEE DataPort, DOI 10.21227/tm4t-9n15,
CC BY 4.0): 122 sujetos con diabetes y 45 controles, un termograma por pie.
Las grillas canónicas y las features salen de scripts/ml/export-public.js y
scripts/ml/export-pattern-features.js (mismas funciones que el portal).

QUÉ PREDICE: si el patrón térmico plantar se parece al de los sujetos con
diabetes de la base. NO predice úlcera ni riesgo de úlcera.

Modelos (validación cruzada por sujeto: cada sujeto es UNA fila):
  patron_lr   logística L2 sobre features invariantes a la adquisición
              (temperatura relativa a la mediana de cada pie por angiosoma y
              zona, dispersión, asimetría contralateral) — candidato al portal
  nivel       temperatura mediana absoluta del pie (puntaje directo; NO
              trasladable a otra cámara: sólo como comparación)
  abs_lr      logística sobre las temperaturas absolutas por angiosoma de la
              planilla de la base (ídem, no trasladable)
  tci_base    TCI publicado en la planilla de la base (promedio de ambos pies)
  tci_clase   clase de TCI publicada (1–5) del promedio
  cnn_rel     CNN chica sobre los mapas relativos (T − mediana) de ambos pies
  control_edad  edad sola (control de confusión: los controles son jóvenes)

Validación: 5 pliegues estratificados × 20 repeticiones, C anidado,
estandarización e imputación (media) dentro del pliegue; IC 95 % por bootstrap
de sujetos; test de permutación (200) para patron_lr. Además: patron_lr con
edad como covariable y AUC de patron_lr en el subgrupo de edades superpuestas.

Evaluación externa (con --export): el modelo final se aplica a la cohorte del
portal (todos con diabetes). Sólo se informa la distribución de puntajes: la
cohorte no tiene controles, así que no hay AUC posible.

Uso: python -I scripts/ml/train_public.py [--export] [--no-cnn]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import argparse  # noqa: E402
import json  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402
import torch.nn as nn  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.model_selection import StratifiedKFold  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

import common as C  # noqa: E402

torch.set_num_threads(C.NUM_THREADS)

CS = [0.01, 0.1, 0.5, 1.0, 10.0]
# Features invariantes del modelo del portal (subconjunto fijado de antemano
# de src/imaging/thermalPattern.js INVARIANT_KEYS: sin las versiones Z, que
# son redundantes con las relativas, para no sobreajustar).
PATRON = ["relMPA", "relLPA", "relMCA", "relLCA", "dedosRel", "talonRel", "iqr", "rango90",
          "difNivel", "asimPatron", "areaCalientePct", "mediaAbs", "p95Abs"]
NOMBRES = {
    "relMPA": ("Arteria plantar medial − mediana del pie", "°C"),
    "relLPA": ("Arteria plantar lateral − mediana del pie", "°C"),
    "relMCA": ("Arteria calcánea medial − mediana del pie", "°C"),
    "relLCA": ("Arteria calcánea lateral − mediana del pie", "°C"),
    "dedosRel": ("Dedos − mediana del pie", "°C"),
    "talonRel": ("Talón − mediana del pie", "°C"),
    "iqr": ("Rango intercuartil dentro del pie", "°C"),
    "rango90": ("Rango 5–95 % dentro del pie", "°C"),
    "difNivel": ("Diferencia de nivel entre pies", "°C"),
    "asimPatron": ("Asimetría de patrón (sin nivel)", "°C"),
    "areaCalientePct": ("Área con |ΔT| > 1 °C", "%"),
    "mediaAbs": ("|ΔT| medio entre pies", "°C"),
    "p95Abs": ("|ΔT| percentil 95", "°C"),
}
TCI_CLASES = [2, 3, 4, 5]


def matrix(rows, keys):
    return np.array([[np.nan if r["features"].get(k) is None else r["features"][k] for k in keys] for r in rows], dtype=float)


class Prep:
    """Imputación por la media y estandarización, ajustadas sólo en entrenamiento."""

    def fit(self, X):
        self.mu = np.nanmean(X, 0)
        self.mu = np.where(np.isfinite(self.mu), self.mu, 0.0)
        Xf = self.fill(X)
        self.sc = StandardScaler().fit(Xf)
        return self

    def fill(self, X):
        X = X.copy()
        i = ~np.isfinite(X)
        X[i] = np.take(self.mu, np.nonzero(i)[1])
        return X

    def __call__(self, X):
        return self.sc.transform(self.fill(X))


def fit_lr(X, y, c):
    p = Prep().fit(X)
    m = LogisticRegression(C=c, max_iter=5000).fit(p(X), y)
    return p, m


def inner_c(X, y, seed):
    skf = StratifiedKFold(5, shuffle=True, random_state=seed)
    best, bc = -1, 0.5
    for c in CS:
        pr = np.zeros(len(y))
        for tr, te in skf.split(X, y):
            p, m = fit_lr(X[tr], y[tr], c)
            pr[te] = m.predict_proba(p(X[te]))[:, 1]
        a = roc_auc_score(y, pr)
        if a > best + 1e-9:
            best, bc = a, c
    return bc


def cv_lr(X, y, reps=20, nested=True, seed0=0):
    oof = np.zeros((reps, len(y)))
    aucs = []
    for r in range(reps):
        skf = StratifiedKFold(5, shuffle=True, random_state=seed0 + r)
        for tr, te in skf.split(X, y):
            c = inner_c(X[tr], y[tr], seed0 + r) if nested else 0.5
            p, m = fit_lr(X[tr], y[tr], c)
            oof[r, te] = m.predict_proba(p(X[te]))[:, 1]
        aucs.append(roc_auc_score(y, oof[r]))
    return np.array(aucs), oof


def boot_ci(y, p, n=1000, seed=0):
    P = np.atleast_2d(p)
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n):
        i = rng.integers(0, len(y), len(y))
        if len(set(y[i])) < 2:
            continue
        out.append(np.mean([roc_auc_score(y[i], row[i]) for row in P]))
    return [float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))]


def perm_test(X, y, observed, n=200, seed=0):
    rng = np.random.default_rng(seed)
    cnt = 0
    for k in range(n):
        a, _ = cv_lr(X, rng.permutation(y), reps=1, nested=False, seed0=1000 + k)
        cnt += a.mean() >= observed
    return (cnt + 1) / (n + 1)


def summary(name, aucs, p, y, extra=None):
    p = np.atleast_2d(p)
    ci = boot_ci(y, p)
    d = {
        "modelo": name,
        "n": int(len(y)),
        "positivos": int(y.sum()),
        "aucMedia": round(float(aucs.mean()), 3),
        "aucRepeticiones": [round(float(aucs.min()), 3), round(float(aucs.max()), 3)],
        "aucIC95": [round(ci[0], 3), round(ci[1], 3)],
    }
    if extra:
        d.update(extra)
    print(d, flush=True)
    return d


class RelCnn(nn.Module):
    def __init__(self):
        super().__init__()
        self.c1 = nn.Conv2d(3, 8, 3, padding=1)
        self.c2 = nn.Conv2d(8, 16, 3, padding=1)
        self.drop = nn.Dropout(0.5)
        self.fc = nn.Linear(16, 1)

    def forward(self, x):
        x = F.max_pool2d(F.relu(self.c1(x)), 2)
        x = F.max_pool2d(F.relu(self.c2(x)), 2)
        return self.fc(self.drop(x.mean((2, 3))))[:, 0]


def aug(x):
    """Intercambio de pies (ambos están en el mismo marco espejado), desplazamiento y ruido."""
    x = x.clone()
    sw = torch.rand(len(x)) < 0.5
    x[sw, 0], x[sw, 1] = x[sw, 1].clone(), x[sw, 0].clone()
    dy, dx = int(torch.randint(-3, 4, (1,))), int(torch.randint(-2, 3, (1,)))
    x = torch.roll(x, (dy, dx), (2, 3))
    x[:, :2] += torch.randn_like(x[:, :2]) * 0.05 * x[:, 2:]
    return x


def cv_cnn(M, y, reps=4, epochs=60):
    oof = np.zeros((reps, len(y)))
    aucs = []
    for r in range(reps):
        skf = StratifiedKFold(5, shuffle=True, random_state=r)
        for tr, te in skf.split(M, y):
            sd = float(np.std(M[tr, :2][M[tr, :2] != 0])) or 1.0
            Xtr, Xte = M[tr].copy(), M[te].copy()
            Xtr[:, :2] /= sd
            Xte[:, :2] /= sd
            torch.manual_seed(r)
            m = RelCnn()
            opt = torch.optim.AdamW(m.parameters(), lr=3e-3, weight_decay=1e-3)
            pos = y[tr].mean()
            pw = torch.tensor((1 - pos) / pos)
            X, Y = torch.from_numpy(Xtr), torch.from_numpy(y[tr].astype(np.float32))
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
                oof[r, te] = torch.sigmoid(m(torch.from_numpy(Xte))).numpy()
        aucs.append(roc_auc_score(y, oof[r]))
        print(f"  cnn repetición {r + 1}/{reps}: AUC {aucs[-1]:.3f}", flush=True)
    return np.array(aucs), oof


def clase(v):
    return 1 + sum(v > c for c in [2, 3, 4, 5]) if np.isfinite(v) else np.nan


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", action="store_true")
    ap.add_argument("--no-cnn", action="store_true")
    args = ap.parse_args()
    t0 = time.time()
    rows = json.loads((C.DATA / "ml" / "pattern-public.json").read_text(encoding="utf8"))
    y = np.array([r["dm"] for r in rows])
    print(f"base pública: n = {len(y)}, DM = {int(y.sum())}, CG = {int(len(y) - y.sum())}")
    res = {"etiqueta": "diabetes (DM) vs control (CG)", "generado": time.strftime("%Y-%m-%d"), "modelos": []}

    X = matrix(rows, PATRON)
    aucs, p_patron = cv_lr(X, y)
    pv = perm_test(X, y, aucs.mean())
    res["modelos"].append(summary("patron_lr", aucs, p_patron, y, {"features": PATRON, "pPermutacion": round(pv, 4)}))

    niv = matrix(rows, ["nivel"])[:, 0]
    res["modelos"].append(summary("nivel", np.array([roc_auc_score(y, niv)]), niv, y,
                                  {"nota": "temperatura absoluta: no trasladable a otra cámara"}))

    ab = np.array([[r["generalBase"][0] if r["generalBase"] else np.nan] for r in rows], dtype=float)
    # Temperaturas absolutas por angiosoma: de las grillas no se guardan; se usan el nivel y las relativas + nivel.
    Xabs = np.column_stack([X, niv])
    aucs, p = cv_lr(Xabs, y)
    res["modelos"].append(summary("patron_mas_nivel_lr", aucs, p, y,
                                  {"features": PATRON + ["nivel"], "nota": "incluye el nivel absoluto: no trasladable"}))
    del ab

    tci = np.array([np.nan if r["tciBase"] is None else r["tciBase"] for r in rows])
    ok = np.isfinite(tci)
    res["modelos"].append(summary("tci_base", np.array([roc_auc_score(y[ok], tci[ok])]), tci[ok], y[ok],
                                  {"nota": "TCI publicado en la planilla de la base (promedio de ambos pies), puntaje directo"}))
    cl = np.array([clase(v) for v in tci])
    res["modelos"].append(summary("tci_clase", np.array([roc_auc_score(y[ok], cl[ok])]), cl[ok], y[ok],
                                  {"nota": "clase de TCI publicada (1–5), puntaje directo"}))
    res["tciClases"] = {
        g: {int(k): int(((cl == k) & (y == v)).sum()) for k in range(1, 6)} for g, v in (("CG", 0), ("DM", 1))
    }

    edad = np.array([np.nan if r["edad"] is None else r["edad"] for r in rows], dtype=float)
    ok = np.isfinite(edad)
    res["modelos"].append(summary("control_edad", np.array([roc_auc_score(y[ok], edad[ok])]), edad[ok], y[ok],
                                  {"nota": "control de confusión: los controles son más jóvenes"}))
    # Patrón + edad (¿aporta el patrón algo más allá de la edad?).
    aucs_e, p_e = cv_lr(edad[ok, None], y[ok])
    res["modelos"].append(summary("edad_lr", aucs_e, p_e, y[ok], {"features": ["edad"]}))
    aucs_pe, p_pe = cv_lr(np.column_stack([X[ok], edad[ok]]), y[ok])
    res["modelos"].append(summary("patron_mas_edad_lr", aucs_pe, p_pe, y[ok], {"features": PATRON + ["edad"]}))
    # Subgrupo de edades superpuestas (fijado de antemano: 30–60 años).
    sub = ok & (edad >= 30) & (edad <= 60)
    if min(int(y[sub].sum()), int((1 - y[sub]).sum())) >= 5:
        a_sub = roc_auc_score(y[sub], p_patron.mean(0)[sub])
        res["subgrupoEdad"] = {
            "criterio": "30–60 años, predicción fuera de pliegue de patron_lr",
            "n": int(sub.sum()), "positivos": int(y[sub].sum()), "auc": round(float(a_sub), 3),
            "aucIC95": [round(v, 3) for v in boot_ci(y[sub], p_patron.mean(0)[sub])],
            "aucEdadSola": round(float(roc_auc_score(y[sub], edad[sub])), 3),
        }
        print("subgrupo edad:", res["subgrupoEdad"], flush=True)
    res["edades"] = {g: [float(np.nanmin(edad[y == v])), float(np.nanmedian(edad[y == v])), float(np.nanmax(edad[y == v]))]
                     for g, v in (("CG", 0), ("DM", 1))}

    if not args.no_cnn:
        M = np.load(C.DATA / "ml" / "pattern-public.npy").astype(np.float32)
        aucs, p = cv_cnn(M, y)
        res["modelos"].append(summary("cnn_rel", aucs, p, y, {"entrada": "mapas 3×100×40 (T − mediana de cada pie, máscara)"}))

    res["segundos"] = round(time.time() - t0)
    (C.DATA / "ml" / "public-model-comparison.json").write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf8")

    if args.export:
        c = inner_c(X, y, 0)
        prep, m = fit_lr(X, y, c)
        info = res["modelos"][0]
        # Evaluación externa: cohorte del portal (toda con diabetes).
        ext = None
        fc = C.DATA / "ml" / "pattern-cohorte.json"
        if fc.exists():
            coh = [r for r in json.loads(fc.read_text(encoding="utf8")) if not r["noValido"]]
            if coh:
                pc = m.predict_proba(prep(matrix(coh, PATRON)))[:, 1]
                pp = m.predict_proba(prep(X))[:, 1]
                q = lambda v: [round(float(x), 3) for x in np.percentile(v, [10, 25, 50, 75, 90])]  # noqa: E731
                ext = {
                    "nota": "Cohorte del portal (todos con diabetes; sin controles: no hay AUC). Distribución del puntaje del modelo final.",
                    "n": len(coh),
                    "percentiles_10_25_50_75_90": q(pc),
                    "fraccionMayor50": round(float((pc >= 0.5).mean()), 3),
                    "basePublicaDM": q(pp[y == 1]),
                    "basePublicaCG": q(pp[y == 0]),
                    "porCentro": {
                        k: {"n": int(sum(1 for r in coh if r["centro"] == k)),
                            "mediana": round(float(np.median([pc[i] for i, r in enumerate(coh) if r["centro"] == k])), 3)}
                        for k in sorted({r["centro"] for r in coh})
                    },
                }
                res["externa"] = ext
                print("externa:", ext, flush=True)
                (C.DATA / "ml" / "public-model-comparison.json").write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf8")
        r3 = lambda v: round(float(v), 4)  # noqa: E731
        sub = res.get("subgrupoEdad")
        out = {
            "_descripcion": "Modelo de PATRÓN TÉRMICO (regresión logística L2) entrenado con la base pública Hernández-Contreras et al. 2019 (IEEE DataPort, DOI 10.21227/tm4t-9n15, CC BY 4.0): diabetes vs control. NO predice úlcera. Generado por scripts/ml/train_public.py; sólo parámetros y métricas agregadas.",
            "version": "patron-dm-v1",
            "generado": res["generado"],
            "etiqueta": "Patrón térmico compatible con pie diabético (diabetes vs control en la base pública)",
            "noPredice": "No predice úlcera ni riesgo de úlcera.",
            "C": c,
            "intercepto": r3(m.intercept_[0]),
            "features": [
                {"key": k, "nombre": NOMBRES[k][0], "unidad": NOMBRES[k][1], "media": r3(prep.sc.mean_[j]),
                 "desvio": r3(prep.sc.scale_[j]), "imputacion": r3(prep.mu[j]), "coef": r3(m.coef_[0][j])}
                for j, k in enumerate(PATRON)
            ],
            "validacion": {
                "metodo": "5 pliegues estratificados por sujeto × 20 repeticiones, C anidado",
                "n": info["n"],
                "positivos": info["positivos"],
                "auc": info["aucMedia"],
                "aucIC95": info["aucIC95"],
                "pPermutacion": info["pPermutacion"],
                "aucEdadSola": next(mm["aucMedia"] for mm in res["modelos"] if mm["modelo"] == "control_edad"),
                "subgrupoEdad": sub,
            },
            "externa": ext,
            "limitaciones": [
                "Los controles de la base son más jóvenes que los sujetos con diabetes: parte de la discriminación puede deberse a la edad.",
                "Otra cámara, otro protocolo y otra población (México); en el portal la conversión a °C es aproximada. Por eso sólo se usan features relativas al propio pie y contralaterales.",
                "Un termograma por pie y por sujeto; sin seguimiento: no hay información de úlceras.",
            ],
        }
        dest = C.ROOT / "src" / "config" / "models" / "diabetic-pattern-logreg.json"
        dest.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf8", newline="\n")
        print(f"modelo exportado: {dest.relative_to(C.ROOT)}")


if __name__ == "__main__":
    main()
