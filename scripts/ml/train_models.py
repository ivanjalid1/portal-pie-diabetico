"""Compara modelos predictivos con validación cruzada por paciente y reporte honesto.

Modelos:
  base      regresión logística L2 sobre área caliente %, |ΔT| medio, |ΔT| p95
            (el modelo preliminar actual del portal)
  tci       TCI solo (puntaje directo, sin ajuste: mayor TCI = mayor riesgo)
  tci_lr    regresión logística L2 sobre TCI + área caliente % + |ΔT| p95
  tci_lr_t2 ídem + cambio entre tomas (p95 de T2 − T1 y % de cambio local);
            sólo pacientes con toma 2
  cnn       CNN chica sobre los mapas registrados (ΔT y desvío TCI de cada pie)

Validación:
  - cada paciente es UNA fila (toma 1), así que los pliegues son por paciente;
  - logísticas: K = 5 estratificado × 20 repeticiones; C elegido en un CV
    interno (anidado) entre {0,01; 0,1; 0,5; 1; 10} con estandarización
    dentro de cada pliegue;
  - CNN: K = 5 × 4 repeticiones (CPU), 60 épocas, sin selección de hiperparámetros
    (fijados de antemano: 2 bloques conv 8–16 canales, dropout 0,5, weight decay 1e-3);
  - AUC: media de las repeticiones y IC 95 % por bootstrap de pacientes (2000)
    sobre la predicción fuera de pliegue promediada entre repeticiones;
  - test de permutación (200) para los modelos logísticos.

Desenlace configurable: --outcome hba1c7 (sustituto, por defecto) | lesion.
Muestra: pacientes con el desenlace registrado, sin la marca «no válido».

Salidas: data-local/ml/model-comparison.json (sólo agregados) y, con
--export, src/config/models/pointwise-tci-logreg.json (coeficientes del
modelo tci_lr ajustado en toda la muestra; sólo agregados).

Uso: python scripts/ml/train_models.py [--outcome hba1c7|lesion] [--export]
"""
import argparse
import json
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold
from sklearn.preprocessing import StandardScaler

import common as C

torch.set_num_threads(C.NUM_THREADS)

CS = [0.01, 0.1, 0.5, 1.0, 10.0]
FEATS = {
    "base": ["areaCalientePct", "mediaAbs", "p95Abs"],
    "tci_lr": ["tci", "areaCalientePct", "p95Abs"],
    "tci_lr_t2": ["tci", "areaCalientePct", "p95Abs", "cambioP95", "cambioLocalPct"],
}
NOMBRES = {
    "tci": ("TCI (índice de cambio térmico)", "°C"),
    "areaCalientePct": ("Área con |ΔT| sobre el umbral", "%"),
    "mediaAbs": ("|ΔT| medio entre pies", "°C"),
    "p95Abs": ("|ΔT| percentil 95", "°C"),
    "cambioP95": ("Cambio entre tomas (p95)", "°C"),
    "cambioLocalPct": ("Área de cambio local entre tomas", "%"),
}


def fit_lr(X, y, c):
    sc = StandardScaler().fit(X)
    m = LogisticRegression(C=c, max_iter=2000).fit(sc.transform(X), y)
    return sc, m


def inner_c(X, y, seed):
    """C por CV interno (5 pliegues; AUC agrupada)."""
    k = min(5, int(min(np.bincount(y))))
    if k < 2:
        return 0.5
    skf = StratifiedKFold(k, shuffle=True, random_state=seed)
    best, bc = -1, 0.5
    for c in CS:
        p = np.zeros(len(y))
        for tr, te in skf.split(X, y):
            sc, m = fit_lr(X[tr], y[tr], c)
            p[te] = m.predict_proba(sc.transform(X[te]))[:, 1]
        a = roc_auc_score(y, p)
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
            sc, m = fit_lr(X[tr], y[tr], c)
            oof[r, te] = m.predict_proba(sc.transform(X[te]))[:, 1]
        aucs.append(roc_auc_score(y, oof[r]))
    return np.array(aucs), oof


def boot_ci(y, p, n=2000, seed=0):
    """IC 95 % por bootstrap de pacientes. `p` puede ser un vector o una matriz
    (repeticiones × pacientes): en ese caso cada remuestra promedia la AUC de
    las repeticiones, así el IC corresponde a la AUC media que se informa."""
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
        yp = rng.permutation(y)
        a, _ = cv_lr(X, yp, reps=1, nested=False, seed0=1000 + k)
        cnt += a.mean() >= observed
    return (cnt + 1) / (n + 1)


class TinyCnn(nn.Module):
    def __init__(self, ch=4):
        super().__init__()
        self.c1 = nn.Conv2d(ch, 8, 3, padding=1)
        self.c2 = nn.Conv2d(8, 16, 3, padding=1)
        self.drop = nn.Dropout(0.5)
        self.fc = nn.Linear(16, 1)

    def forward(self, x):
        x = F.max_pool2d(F.relu(self.c1(x)), 2)
        x = F.max_pool2d(F.relu(self.c2(x)), 2)
        x = x.mean((2, 3))
        return self.fc(self.drop(x))[:, 0]


def aug_maps(x):
    """Aumento: intercambio de pies (niega ΔT y cambia los canales de desvío), desplazamiento ±3 filas / ±2 columnas, ruido.

    Con 4 canales: ΔT, desvío izq., desvío der., máscara. Con 2: ΔT y máscara."""
    x = x.clone()
    sw = torch.rand(len(x)) < 0.5
    x[sw, 0] = -x[sw, 0]
    if x.shape[1] == 4:
        x[sw, 1], x[sw, 2] = x[sw, 2].clone(), x[sw, 1].clone()
    dy, dx = int(torch.randint(-3, 4, (1,))), int(torch.randint(-2, 3, (1,)))
    x = torch.roll(x, (dy, dx), (2, 3))
    k = x.shape[1] - 1
    x[:, :k] += torch.randn_like(x[:, :k]) * 0.05 * x[:, k:]
    return x


def train_cnn(Xtr, ytr, epochs=60, seed=0):
    torch.manual_seed(seed)
    m = TinyCnn(Xtr.shape[1])
    opt = torch.optim.AdamW(m.parameters(), lr=3e-3, weight_decay=1e-3)
    pos = max(ytr.mean(), 1e-3)
    pw = torch.tensor((1 - pos) / pos)
    X, Y = torch.from_numpy(Xtr), torch.from_numpy(ytr.astype(np.float32))
    for _ in range(epochs):
        m.train()
        perm = torch.randperm(len(X))
        for i in range(0, len(X), 8):
            idx = perm[i : i + 8]
            loss = F.binary_cross_entropy_with_logits(m(aug_maps(X[idx])), Y[idx], pos_weight=pw)
            opt.zero_grad()
            loss.backward()
            opt.step()
    m.eval()
    return m


def cv_cnn(M, y, reps=4):
    oof = np.zeros((reps, len(y)))
    aucs = []
    for r in range(reps):
        skf = StratifiedKFold(5, shuffle=True, random_state=r)
        for tr, te in skf.split(M, y):
            k = M.shape[1] - 1
            mu = M[tr, :k].reshape(len(tr), k, -1)
            sd = float(np.std(mu[mu != 0])) or 1.0
            Xtr = M[tr].copy()
            Xte = M[te].copy()
            Xtr[:, :k] /= sd
            Xte[:, :k] /= sd
            m = train_cnn(Xtr, y[tr], seed=r)
            with torch.no_grad():
                oof[r, te] = torch.sigmoid(m(torch.from_numpy(Xte))).numpy()
        aucs.append(roc_auc_score(y, oof[r]))
        print(f"  cnn repetición {r + 1}/{reps}: AUC {aucs[-1]:.3f}", flush=True)
    return np.array(aucs), oof


def summary(name, aucs, p, y, extra=None):
    """p: predicciones fuera de pliegue (repeticiones × pacientes) o un puntaje directo."""
    p = np.atleast_2d(p)
    ci = boot_ci(y, p, n=1000 if len(p) > 1 else 2000)
    d = {
        "modelo": name,
        "n": int(len(y)),
        "positivos": int(y.sum()),
        "aucMedia": round(float(aucs.mean()), 3),
        "aucRepeticiones": [round(float(aucs.min()), 3), round(float(aucs.max()), 3)],
        "aucPromediada": round(float(roc_auc_score(y, p.mean(0))), 3),
        "aucIC95": [round(ci[0], 3), round(ci[1], 3)],
    }
    if extra:
        d.update(extra)
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outcome", default="hba1c7", choices=["hba1c7", "lesion"])
    ap.add_argument("--export", action="store_true")
    ap.add_argument("--no-cnn", action="store_true")
    args = ap.parse_args()
    t0 = time.time()
    rows = json.loads((C.DATA / "ml" / "features.json").read_text(encoding="utf8"))
    maps = np.load(C.DATA / "ml" / "maps.npy")
    sel = [r for r in rows if not r["noValido"] and r["desenlaces"][args.outcome] is not None]
    y = np.array([r["desenlaces"][args.outcome] for r in sel])
    print(f"desenlace {args.outcome}: n = {len(y)}, positivos = {int(y.sum())}")
    res = {"desenlace": args.outcome, "generado": time.strftime("%Y-%m-%d"), "modelos": []}
    if min(int(y.sum()), int(len(y) - y.sum())) < 5:
        res["nota"] = "Menos de 5 casos en alguna clase: no se puede validar ningún modelo."
        print(res["nota"])
        (C.DATA / "ml" / f"model-comparison-{args.outcome}.json").write_text(json.dumps(res, indent=2), encoding="utf8")
        return

    def X_of(keys, rs):
        return np.array([[r["features"][k] for k in keys] for r in rs], dtype=float)

    for name in ("base", "tci_lr"):
        X = X_of(FEATS[name], sel)
        aucs, p = cv_lr(X, y)
        pv = perm_test(X, y, aucs.mean())
        res["modelos"].append(summary(name, aucs, p, y, {"features": FEATS[name], "pPermutacion": round(pv, 3)}))
        print(res["modelos"][-1], flush=True)

    t = X_of(["tci"], sel)[:, 0]
    a = roc_auc_score(y, t)
    res["modelos"].append(summary("tci", np.array([a]), t, y, {"features": ["tci"], "nota": "puntaje directo, sin ajuste"}))
    print(res["modelos"][-1], flush=True)
    # Control de confusión (agregado tras ver el primer resultado): el centro de
    # atención solo, como puntaje directo. El TCI absoluto depende del ambiente
    # y del equipo de cada centro, y la prevalencia del desenlace varía por centro.
    centro = np.array([1.0 if r["grupo"].startswith("P.HC") else 0.0 for r in sel])
    a = roc_auc_score(y, centro)
    res["modelos"].append(summary("control_centro", np.array([a]), centro, y,
                                  {"features": ["centro HC"], "nota": "control de confusión, no candidato"}))
    print(res["modelos"][-1], flush=True)
    for k in ("tciPuntual", "tciPatron", "areaCalientePct", "mediaAbs", "p95Abs"):
        res.setdefault("aucUnivariada", {})[k] = round(float(roc_auc_score(y, X_of([k], sel)[:, 0])), 3)

    s2 = [r for r in sel if r["features"]["cambioP95"] is not None]
    y2 = np.array([r["desenlaces"][args.outcome] for r in s2])
    if min(int(y2.sum()), int(len(y2) - y2.sum())) >= 5:
        X2 = X_of(FEATS["tci_lr_t2"], s2)
        aucs, p = cv_lr(X2, y2)
        pv = perm_test(X2, y2, aucs.mean())
        res["modelos"].append(summary("tci_lr_t2", aucs, p, y2, {"features": FEATS["tci_lr_t2"], "pPermutacion": round(pv, 3)}))
        # Comparación justa: el modelo base en la MISMA submuestra con toma 2.
        aucs, p = cv_lr(X_of(FEATS["base"], s2), y2)
        res["modelos"].append(summary("base_subt2", aucs, p, y2, {"features": FEATS["base"]}))
        print(res["modelos"][-2:], flush=True)

    if not args.no_cnn:
        M = maps[[r["id"] for r in sel]].astype(np.float32)
        aucs, p = cv_cnn(M, y)
        res["modelos"].append(summary("cnn", aucs, p, y, {"entrada": "mapas 4×100×40 (ΔT, desvío TCI izq/der, máscara)"}))
        print(res["modelos"][-1], flush=True)
        # Variante sólo con el mapa de asimetría (sin el nivel absoluto del desvío TCI).
        aucs, p = cv_cnn(M[:, [0, 3]], y)
        res["modelos"].append(summary("cnn_dt", aucs, p, y, {"entrada": "mapas 2×100×40 (ΔT, máscara)"}))
        print(res["modelos"][-1], flush=True)

    # Regla de elección (fijada de antemano): un modelo cuenta como «con señal»
    # sólo si el límite inferior de su IC 95 % supera 0,5; entre ellos, el de
    # mayor AUC media. Si ninguno, se mantiene el preliminar actual.
    con_senal = [m for m in res["modelos"] if m["aucIC95"][0] > 0.5 and not m["modelo"].startswith("control")]
    res["eleccion"] = max(con_senal, key=lambda m: m["aucMedia"])["modelo"] if con_senal else None
    res["segundos"] = round(time.time() - t0)
    (C.DATA / "ml" / f"model-comparison-{args.outcome}.json").write_text(json.dumps(res, indent=2), encoding="utf8")
    print("elección:", res["eleccion"])

    if args.export:
        X = X_of(FEATS["tci_lr"], sel)
        c = inner_c(X, y, 0)
        sc, m = fit_lr(X, y, c)
        info = next(mm for mm in res["modelos"] if mm["modelo"] == "tci_lr")
        r3 = lambda v: round(float(v), 3)  # noqa: E731
        out = {
            "_descripcion": "Modelo EXPERIMENTAL (regresión logística L2) sobre TCI + features punto a punto de la toma 1. Generado por scripts/ml/train_models.py. Sólo contiene parámetros y métricas agregadas.",
            "version": "puntual-tci-logreg-v1",
            "generado": res["generado"],
            "desenlace": "HbA1c > 7 % (sustituto, igual que la Parte 1)" if args.outcome == "hba1c7" else "Lesión en el seguimiento",
            "umbralPixel": 1,
            "C": c,
            "intercepto": r3(m.intercept_[0]),
            "features": [
                {"key": k, "nombre": NOMBRES[k][0], "unidad": NOMBRES[k][1], "media": r3(sc.mean_[j]),
                 "desvio": r3(sc.scale_[j]), "coef": r3(m.coef_[0][j])}
                for j, k in enumerate(FEATS["tci_lr"])
            ],
            "validacion": {
                "metodo": "5 pliegues estratificados × 20 repeticiones, C anidado",
                "n": info["n"],
                "positivos": info["positivos"],
                "auc": info["aucMedia"],
                "aucIC95": info["aucIC95"],
                "pPermutacion": info["pPermutacion"],
                "kFold": {"metodo": "5 pliegues estratificados × 20 repeticiones", "aucMedia": info["aucMedia"]},
            },
            "muestra": {"criterio": "Pacientes con el desenlace registrado y toma 1 analizable; se excluyen los marcados «PACIENTE NO VALIDO»."},
        }
        dest = C.ROOT / "src" / "config" / "models" / "pointwise-tci-logreg.json"
        dest.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf8", newline="\n")
        print(f"modelo exportado: {dest.relative_to(C.ROOT)}")


if __name__ == "__main__":
    main()
