"""Controles de la CNN de factor de riesgo (train_riskfactor.py) y exportación.

La CNN chica sobre los mapas relativos, PREENTRENADA en la base pública
(diabetes vs control) y ajustada en la cohorte, fue la variante con más señal
para neuropatía (la CNN sin preentrenar también tuvo señal, menor). Antes de usarla se verifica, con el MISMO procedimiento de CV:
  1. permutación de la etiqueta DENTRO de cada centro (repite toda la CV de la
     CNN con la etiqueta permutada: conserva la confusión por centro);
  2. sólo Hospital Córdoba: entrenar y evaluar dentro del centro;
  3. ¿agrega a la clínica?: logística sobre edad + años de diabetes con y sin
     el puntaje de la CNN fuera de pliegue (CV anidada aparte);
  4. proxies de adquisición: AUC de la calidad de segmentación y del tipo de
     segmentación (U-Net / clásica) para la etiqueta, dentro del centro.
Regla (la misma de train_riskfactor.py, fijada antes): IC inferior > 0,5,
permutación dentro de centro p < 0,05 y AUC dentro de centro > 0,5.

Con --export (sólo si cumple): entrena 5 CNN (semillas 0–4) con TODA la muestra
y escribe los pesos en data-local/models/riskfactor-<label>-cnn.json (deriva de
datos reales: no se versiona). El portal la evalúa en JS
(src/services/predictors/riskFactorCnn.js).

Uso: python -I scripts/ml/check_riskfactor_cnn.py [--label neuropatia] [--perms 100] [--export]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import argparse  # noqa: E402
import json  # noqa: E402
import time  # noqa: E402
import warnings  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402

import common as C  # noqa: E402
from train_public import RelCnn, aug, boot_ci  # noqa: E402
from train_adjusted import cv_lr, within_auc  # noqa: E402
from train_riskfactor import cv_cnn, pretrain_public  # noqa: E402

warnings.filterwarnings("ignore")
torch.set_num_threads(C.NUM_THREADS)


def load(label):
    rows = json.loads((C.DATA / "ml" / "pattern-cohorte.json").read_text(encoding="utf8"))
    Mall = np.load(C.DATA / "ml" / "pattern-cohorte.npy").astype(np.float32)
    idx = [i for i, r in enumerate(rows) if not r["noValido"] and r["desenlaces"].get(label) is not None]
    sel = [rows[i] for i in idx]
    y = np.array([r["desenlaces"][label] for r in sel])
    centro = np.array([r["centro"] for r in sel])
    return sel, Mall[idx], y, centro


def train_full(M, y, seed, sd, pre, epochs=30):
    X = M.copy()
    X[:, :2] /= sd
    torch.manual_seed(seed)
    m = RelCnn()
    m.load_state_dict(pre)
    opt = torch.optim.AdamW(m.parameters(), lr=1e-3, weight_decay=1e-3)
    pw = torch.tensor((1 - y.mean()) / y.mean())
    Xt, Yt = torch.from_numpy(X), torch.from_numpy(y.astype(np.float32))
    for _ in range(epochs):
        m.train()
        perm = torch.randperm(len(Xt))
        for i in range(0, len(Xt), 8):
            idx = perm[i : i + 8]
            loss = F.binary_cross_entropy_with_logits(m(aug(Xt[idx])), Yt[idx], pos_weight=pw)
            opt.zero_grad()
            loss.backward()
            opt.step()
    m.eval()
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="neuropatia")
    ap.add_argument("--perms", type=int, default=100)
    ap.add_argument("--seed", type=int, default=0, help="semilla de las permutaciones (para sumar tandas)")
    ap.add_argument("--export", action="store_true")
    args = ap.parse_args()
    t0 = time.time()
    sel, M, y, centro = load(args.label)
    hc = (centro == "Hospital Córdoba").astype(int)
    strata = y * 2 + hc
    res = {"etiqueta": args.label, "generado": time.strftime("%Y-%m-%d"), "n": int(len(y)), "positivos": int(y.sum())}
    print(f"{args.label}: n = {len(y)}, positivos = {int(y.sum())}", flush=True)

    sd = float(np.std(M[:, :2][M[:, :2] != 0])) or 1.0
    pre = pretrain_public(sd)
    aucs, oof = cv_cnn(M, y, strata, pre=pre)
    p = oof.mean(0)
    w, wm = within_auc(y, p, centro)
    res["cnn"] = {"aucMedia": round(float(aucs.mean()), 3), "aucIC95": [round(v, 3) for v in boot_ci(y, oof)],
                  "aucDentroDeCentro": w, "aucDentroPonderada": wm}
    print("cnn:", res["cnn"], flush=True)

    # 4. Proxies de adquisición dentro de Hospital Córdoba.
    i = hc == 1
    cal = np.array([r["calidad"] if r["calidad"] is not None else np.nan for r in sel], float)
    useg = np.array([1.0 if r["segmentacion"] == "unet" else 0.0 for r in sel])
    res["proxies"] = {
        "calidadSegmentacion_aucHC": round(float(roc_auc_score(y[i], np.nan_to_num(cal[i], nan=np.nanmedian(cal)))), 3),
        "segmentacionUnet_aucHC": round(float(roc_auc_score(y[i], useg[i])), 3) if len(set(useg[i])) > 1 else None,
        "correlacionCnnCalidad": round(float(np.corrcoef(p[np.isfinite(cal)], cal[np.isfinite(cal)])[0, 1]), 3),
    }
    print("proxies:", res["proxies"], flush=True)

    # 3. ¿Agrega a la clínica? (edad + años de diabetes) — puntaje CNN fuera de pliegue como covariable.
    cov = lambda k: np.array([np.nan if r["covariables"][k] is None else r["covariables"][k] for r in sel], float)  # noqa: E731
    Xc = np.column_stack([cov("edad"), cov("aniosDm")])
    a0, p0 = cv_lr(Xc, y, strata)
    a1, p1 = cv_lr(np.column_stack([Xc, p]), y, strata)
    res["sumaAClinica"] = {"clinica": round(float(a0.mean()), 3), "clinicaIC95": [round(v, 3) for v in boot_ci(y, p0)],
                           "clinicaMasCnn": round(float(a1.mean()), 3), "clinicaMasCnnIC95": [round(v, 3) for v in boot_ci(y, p1)],
                           "nota": "el puntaje CNN es fuera de pliegue de otra CV: estimación aproximada"}
    print("suma a la clínica:", res["sumaAClinica"], flush=True)

    # 2. Sólo Hospital Córdoba.
    ah, oh = cv_cnn(M[i], y[i], y[i], pre=pre)
    res["soloHospitalCordoba"] = {"n": int(i.sum()), "positivos": int(y[i].sum()), "aucMedia": round(float(ah.mean()), 3),
                                  "aucIC95": [round(v, 3) for v in boot_ci(y[i], oh)]}
    print("solo HC:", res["soloHospitalCordoba"], flush=True)

    # 1. Permutación dentro de centro (CV completa de la CNN, 1 repetición por permutación).
    rng = np.random.default_rng(args.seed)
    obs = float(aucs.mean())
    cnt = 0
    null = []
    for k in range(args.perms):
        yp = y.copy()
        for c in np.unique(centro):
            j = np.nonzero(centro == c)[0]
            yp[j] = rng.permutation(y[j])
        a, _ = cv_cnn(M, yp, yp * 2 + hc, reps=1, pre=pre)
        null.append(float(a.mean()))
        cnt += a.mean() >= obs
        if (k + 1) % 10 == 0:
            print(f"  permutación {k + 1}/{args.perms}: p parcial {(cnt + 1) / (k + 2):.3f}", flush=True)
    res["pPermutacionDentroDeCentro"] = round((cnt + 1) / (args.perms + 1), 4)
    res["permutaciones"] = {"n": args.perms, "semilla": args.seed, "igualOMayor": int(cnt), "maximoNulo": round(max(null), 3) if null else None}
    res["nulaPercentiles_50_95"] = [round(float(np.percentile(null, q)), 3) for q in (50, 95)]
    regla = res["cnn"]["aucIC95"][0] > 0.5 and res["pPermutacionDentroDeCentro"] < 0.05 and (wm or 0) > 0.5
    res["regla"] = {"cumple": bool(regla),
                    "criterio": "IC inferior > 0,5, permutación dentro de centro p < 0,05 y AUC dentro de centro > 0,5 (fijado de antemano)"}
    res["segundos"] = round(time.time() - t0)
    (C.DATA / "ml" / f"riskfactor-cnn-{args.label}{'-s' + str(args.seed) if args.seed else ''}.json").write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf8")
    print("permutación:", res["pPermutacionDentroDeCentro"], "regla:", res["regla"], flush=True)

    if args.export:
        if not regla:
            print("No cumple la regla: no se exporta.")
            sys.exit(2)
        nets = []
        for seed in range(5):
            m = train_full(M, y, seed, sd, pre)
            nets.append({k: np.round(v.detach().numpy().astype(float), 6).tolist() for k, v in m.state_dict().items()})
        # Calibración en la escala de la muestra: el puntaje medio de las 5 redes fuera de pliegue
        # ya está en `p`; se informa la prevalencia de entrenamiento para documentar el pos_weight.
        out = {
            "_descripcion": f"CNN chica (2 conv 3×3 de 8 y 16 canales, max-pool, media global, lineal) sobre los mapas relativos (T − mediana de cada pie) de la toma 1, preentrenada en la base pública Hernández-Contreras 2019 (diabetes vs control) y ajustada en la cohorte. Estima la probabilidad de {args.label} registrada en la planilla. Entrenada con la cohorte propia (scripts/ml/check_riskfactor_cnn.py). Deriva de datos reales: no se versiona.",
            "version": f"cnn-{args.label}-v1",
            "generado": res["generado"],
            "etiqueta": args.label,
            "entrada": {"forma": [3, 100, 40], "escala": round(sd, 6),
                        "canales": ["izquierdo − mediana", "derecho espejado − mediana", "máscara (dato en ambos)"]},
            "pesoPositivos": round(float((1 - y.mean()) / y.mean()), 4),
            "prevalencia": round(float(y.mean()), 4),
            "redes": nets,
            "validacion": {"metodo": "5 pliegues estratificados por etiqueta × centro, 4 repeticiones; hiperparámetros fijos; preentrenamiento sin datos de la cohorte",
                           "n": res["n"], "positivos": res["positivos"], "auc": res["cnn"]["aucMedia"],
                           "aucIC95": res["cnn"]["aucIC95"], "aucDentroDeCentro": wm,
                           "pPermutacionDentroDeCentro": res["pPermutacionDentroDeCentro"],
                           "soloHospitalCordoba": res["soloHospitalCordoba"], "sumaAClinica": res["sumaAClinica"]},
        }
        dest = C.MODELS / f"riskfactor-{args.label}-cnn.json"
        dest.write_text(json.dumps(out, ensure_ascii=False) + "\n", encoding="utf8")
        print("modelo exportado:", dest.relative_to(C.ROOT))


if __name__ == "__main__":
    main()
