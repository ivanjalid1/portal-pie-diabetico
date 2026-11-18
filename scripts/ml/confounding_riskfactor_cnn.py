"""Confusión clínica de la CNN de neuropatía (check_riskfactor_cnn.py).

La CNN se preentrena con diabetes vs control en la base pública, donde la edad
separa los grupos (§8.6). La neuropatía también se asocia con la edad y con los
años de diabetes. Aquí, con el puntaje fuera de pliegue de la misma CV:
  - correlación de Spearman del puntaje con la edad y con los años de diabetes;
  - AUC dentro de estratos de edad (< 55 / ≥ 55, mediana aproximada de la cohorte);
  - logística de la neuropatía sobre edad + años de diabetes + puntaje (sin CV,
    sólo para el coeficiente y su razón de verosimilitud).
Sólo agregados en la salida: data-local/ml/riskfactor-cnn-confusion.json.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import json  # noqa: E402
import warnings  # noqa: E402

import numpy as np  # noqa: E402
from scipy.stats import chi2, spearmanr  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import log_loss, roc_auc_score  # noqa: E402

import common as C  # noqa: E402
from check_riskfactor_cnn import load  # noqa: E402
from train_riskfactor import cv_cnn, pretrain_public  # noqa: E402

warnings.filterwarnings("ignore")


def main():
    sel, M, y, centro = load("neuropatia")
    hc = (centro == "Hospital Córdoba").astype(int)
    sd = float(np.std(M[:, :2][M[:, :2] != 0])) or 1.0
    aucs, oof = cv_cnn(M, y, y * 2 + hc, pre=pretrain_public(sd))
    p = oof.mean(0)
    cov = lambda k: np.array([np.nan if r["covariables"][k] is None else r["covariables"][k] for r in sel], float)  # noqa: E731
    edad, anios = cov("edad"), cov("aniosDm")
    ok = np.isfinite(edad) & np.isfinite(anios)
    res = {"n": int(len(y)), "aucCnn": round(float(aucs.mean()), 3),
           "spearmanEdad": round(float(spearmanr(p[ok], edad[ok])[0]), 3),
           "spearmanAniosDm": round(float(spearmanr(p[ok], anios[ok])[0]), 3), "estratosEdad": {}}
    for name, m in (("<55", ok & (edad < 55)), (">=55", ok & (edad >= 55))):
        if min(int(y[m].sum()), int((1 - y[m]).sum())) >= 3:
            res["estratosEdad"][name] = {"n": int(m.sum()), "positivos": int(y[m].sum()),
                                         "aucCnn": round(float(roc_auc_score(y[m], p[m])), 3),
                                         "aucAniosDm": round(float(roc_auc_score(y[m], anios[m])), 3)}
    z = lambda v: (v - v[ok].mean()) / v[ok].std()  # noqa: E731
    X0 = np.column_stack([z(edad), z(anios)])[ok]
    lg = np.log(np.clip(p, 1e-4, 1 - 1e-4) / np.clip(1 - p, 1e-4, 1))
    X1 = np.column_stack([X0, z(lg)[ok]])
    m0 = LogisticRegression(C=1e6, max_iter=5000).fit(X0, y[ok])
    m1 = LogisticRegression(C=1e6, max_iter=5000).fit(X1, y[ok])
    ll0 = -log_loss(y[ok], m0.predict_proba(X0)[:, 1], normalize=False)
    ll1 = -log_loss(y[ok], m1.predict_proba(X1)[:, 1], normalize=False)
    lr = 2 * (ll1 - ll0)
    res["ajusteClinico"] = {"coefPuntajeZ": round(float(m1.coef_[0][2]), 3), "razonVerosimilitud": round(float(lr), 2),
                            "p": round(float(chi2.sf(lr, 1)), 4),
                            "nota": "logística sin penalizar sobre edad + años de diabetes ± logit del puntaje CNN fuera de pliegue"}
    print(json.dumps(res, indent=2, ensure_ascii=False))
    (C.DATA / "ml" / "riskfactor-cnn-confusion.json").write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf8")


if __name__ == "__main__":
    main()
