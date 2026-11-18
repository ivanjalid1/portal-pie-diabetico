'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { GRID, decodeGrid } = require('../../imaging/pointwise');

/**
 * CNN de FACTOR DE RIESGO entrenada con la cohorte propia
 * (scripts/ml/check_riskfactor_cnn.py): estima la probabilidad de neuropatía
 * (pérdida de sensibilidad protectora, el factor que define el grupo IWGDF 1)
 * desde el mapa térmico relativo de ambos pies de la toma 1. Se preentrenó con
 * la base pública Hernández-Contreras 2019 (diabetes vs control) y se ajustó
 * con la neuropatía registrada en la planilla.
 *
 * Deriva de datos reales: vive en data-local/models/ (ignorada por git y
 * Vercel). RIESGO_FACTOR_MODELO cambia la ruta. Sin archivo (CI, Vercel) el
 * portal no la usa.
 *
 * Arquitectura (la de RelCnn en scripts/ml/train_public.py), evaluada en JS:
 * conv 3×3 (3→8) + ReLU + max-pool 2 → conv 3×3 (8→16) + ReLU + max-pool 2 →
 * media global → lineal (16→1). Promedio de 5 redes (semillas 0–4).
 */
const RISK_FACTOR_MODEL_PATH =
  process.env.RIESGO_FACTOR_MODELO ||
  path.join(__dirname, '..', '..', '..', 'data-local', 'models', 'riskfactor-neuropatia-cnn.json');

/** Requisitos (los mismos de la regla fijada antes de entrenar). */
const REQUISITOS = Object.freeze({ positivos: 10, negativos: 10, pPermutacion: 0.05 });

function loadRiskFactorModel(file = RISK_FACTOR_MODEL_PATH) {
  // Las pruebas no dependen de un modelo local derivado de datos reales.
  if (process.env.NODE_ENV === 'test' && !process.env.RIESGO_FACTOR_MODELO && file === RISK_FACTOR_MODEL_PATH)
    return null;
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

/** IC inferior > 0,5, permutación dentro de centro p < 0,05, AUC dentro de centro > 0,5 y casos suficientes. */
function isValidated(model) {
  const v = model?.validacion;
  if (!v || !Array.isArray(model.redes) || !model.redes.length) return false;
  const pos = v.positivos ?? 0;
  const neg = (v.n ?? 0) - pos;
  return (
    pos >= REQUISITOS.positivos &&
    neg >= REQUISITOS.negativos &&
    (v.aucIC95?.[0] ?? 0) > 0.5 &&
    (v.pPermutacionDentroDeCentro ?? 1) < REQUISITOS.pPermutacion &&
    (v.aucDentroDeCentro ?? 0) > 0.5
  );
}

function median(g) {
  const v = [...g].filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : NaN;
}

/** Entrada 3 × H × W: izq − mediana, der − mediana (escalados), máscara de celdas con dato en ambos. */
function inputMaps(izq, der, escala = 1) {
  const n = GRID.w * GRID.h;
  const mi = median(izq);
  const md = median(der);
  const x = new Float32Array(3 * n);
  for (let i = 0; i < n; i += 1) {
    const a = Number.isFinite(izq[i]);
    const b = Number.isFinite(der[i]);
    if (a) x[i] = (izq[i] - mi) / escala;
    if (b) x[n + i] = (der[i] - md) / escala;
    x[2 * n + i] = a && b ? 1 : 0;
  }
  return x;
}

/** Convolución 3×3 con padding 1 + ReLU. w: [out][in][3][3]. */
function conv3Relu(x, cin, h, w, weight, bias) {
  const cout = bias.length;
  const out = new Float32Array(cout * h * w);
  for (let o = 0; o < cout; o += 1) {
    for (let r = 0; r < h; r += 1) {
      for (let c = 0; c < w; c += 1) {
        let s = bias[o];
        for (let k = 0; k < cin; k += 1) {
          const wk = weight[o][k];
          const base = k * h * w;
          for (let dr = -1; dr <= 1; dr += 1) {
            const rr = r + dr;
            if (rr < 0 || rr >= h) continue;
            for (let dc = -1; dc <= 1; dc += 1) {
              const cc = c + dc;
              if (cc < 0 || cc >= w) continue;
              s += wk[dr + 1][dc + 1] * x[base + rr * w + cc];
            }
          }
        }
        out[o * h * w + r * w + c] = s > 0 ? s : 0;
      }
    }
  }
  return out;
}

/** Max-pool 2×2 (piso, como torch). */
function maxPool2(x, ch, h, w) {
  const h2 = Math.floor(h / 2);
  const w2 = Math.floor(w / 2);
  const out = new Float32Array(ch * h2 * w2);
  for (let k = 0; k < ch; k += 1) {
    for (let r = 0; r < h2; r += 1) {
      for (let c = 0; c < w2; c += 1) {
        const b = k * h * w;
        const i = b + 2 * r * w + 2 * c;
        out[k * h2 * w2 + r * w2 + c] = Math.max(x[i], x[i + 1], x[i + w], x[i + w + 1]);
      }
    }
  }
  return { out, h: h2, w: w2 };
}

/** Logit de una red (pesos en el formato de state_dict de PyTorch). */
function netLogit(net, x) {
  const H = GRID.h;
  const W = GRID.w;
  const a1 = conv3Relu(x, 3, H, W, net['c1.weight'], net['c1.bias']);
  const p1 = maxPool2(a1, 8, H, W);
  const a2 = conv3Relu(p1.out, 8, p1.h, p1.w, net['c2.weight'], net['c2.bias']);
  const p2 = maxPool2(a2, 16, p1.h, p1.w);
  const n = p2.h * p2.w;
  let s = net['fc.bias'][0];
  for (let k = 0; k < 16; k += 1) {
    let m = 0;
    for (let i = 0; i < n; i += 1) m += p2.out[k * n + i];
    s += net['fc.weight'][0][k] * (m / n);
  }
  return s;
}

/**
 * Probabilidad (0–1) del factor de riesgo para una toma con grillas codificadas.
 * El entrenamiento usó pos_weight = (1 − prevalencia) / prevalencia; se corrige
 * el logit (− ln pos_weight) para volver a la escala de la prevalencia de la muestra.
 */
function riskFactorProbability(model, toma) {
  if (!model || !toma?.izq || !toma?.der) return null;
  const izq = decodeGrid(toma.izq);
  const der = decodeGrid(toma.der);
  const x = inputMaps(izq, der, model.entrada?.escala || 1);
  let comparables = 0;
  for (let i = 2 * GRID.w * GRID.h; i < x.length; i += 1) comparables += x[i];
  if (comparables < 0.2 * GRID.w * GRID.h) return null;
  const corr = Math.log(model.pesoPositivos || 1);
  const ps = model.redes.map((net) => 1 / (1 + Math.exp(-(netLogit(net, x) - corr))));
  return ps.reduce((a, b) => a + b, 0) / ps.length;
}

module.exports = {
  RISK_FACTOR_MODEL_PATH,
  REQUISITOS,
  loadRiskFactorModel,
  isValidated,
  inputMaps,
  netLogit,
  riskFactorProbability,
};
