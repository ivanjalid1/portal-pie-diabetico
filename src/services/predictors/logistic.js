'use strict';

/**
 * Regresión logística con penalización L2 (Newton-Raphson / IRLS), métricas
 * de validación (AUC) y validación cruzada leave-one-out. Sin dependencias:
 * la usan el script de entrenamiento y las pruebas.
 *
 * Objetivo (igual que scikit-learn con `C`):
 *   minimizar  C · Σ log-loss(yᵢ, σ(b + w·xᵢ)) + ½‖w‖²   (el intercepto no se penaliza)
 */

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function standardize(X) {
  const d = X[0].length;
  const media = Array(d).fill(0);
  const desvio = Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j += 1) media[j] += x[j] / X.length;
  for (const x of X) for (let j = 0; j < d; j += 1) desvio[j] += (x[j] - media[j]) ** 2 / X.length;
  for (let j = 0; j < d; j += 1) desvio[j] = Math.sqrt(desvio[j]) || 1;
  return { media, desvio };
}

const applyScale = (x, s) => x.map((v, j) => (v - s.media[j]) / s.desvio[j]);

/** Resuelve A·x = b por eliminación de Gauss con pivoteo parcial. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r += 1) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  const x = Array(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k += 1) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * Ajusta el modelo sobre X (ya estandarizado) e y ∈ {0,1}.
 * @returns {{intercepto:number, coef:number[]}}
 */
function fitLogistic(X, y, { C = 0.5, iter = 50 } = {}) {
  const d = X[0].length;
  let beta = Array(d + 1).fill(0); // [b, w1..wd]
  for (let it = 0; it < iter; it += 1) {
    const g = Array(d + 1).fill(0);
    const H = Array.from({ length: d + 1 }, () => Array(d + 1).fill(0));
    for (let i = 0; i < X.length; i += 1) {
      const xi = [1, ...X[i]];
      const p = sigmoid(xi.reduce((s, v, j) => s + v * beta[j], 0));
      const wgt = p * (1 - p);
      for (let j = 0; j <= d; j += 1) {
        g[j] += C * (p - y[i]) * xi[j];
        for (let k = 0; k <= d; k += 1) H[j][k] += C * wgt * xi[j] * xi[k];
      }
    }
    for (let j = 1; j <= d; j += 1) {
      g[j] += beta[j];
      H[j][j] += 1;
    }
    H[0][0] += 1e-9;
    const step = solve(H, g);
    beta = beta.map((b, j) => b - step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return { intercepto: beta[0], coef: beta.slice(1) };
}

const predictProba = (model, x) => sigmoid(model.intercepto + x.reduce((s, v, j) => s + v * model.coef[j], 0));

/** AUC (Mann-Whitney): probabilidad de que un positivo puntúe más que un negativo. */
function auc(scores, y) {
  let pos = 0;
  let neg = 0;
  let acc = 0;
  for (let i = 0; i < y.length; i += 1) {
    if (y[i] !== 1) continue;
    pos += 1;
    for (let j = 0; j < y.length; j += 1) {
      if (y[j] !== 0) continue;
      if (scores[i] > scores[j]) acc += 1;
      else if (scores[i] === scores[j]) acc += 0.5;
    }
  }
  for (const v of y) if (v === 0) neg += 1;
  return pos && neg ? acc / (pos * neg) : NaN;
}

/** Validación cruzada leave-one-out (la estandarización se ajusta dentro de cada pliegue). */
function looPredictions(Xraw, y, opts) {
  return Xraw.map((_, i) => {
    const Xtr = Xraw.filter((__, k) => k !== i);
    const ytr = y.filter((__, k) => k !== i);
    const s = standardize(Xtr);
    const m = fitLogistic(
      Xtr.map((x) => applyScale(x, s)),
      ytr,
      opts,
    );
    return predictProba(m, applyScale(Xraw[i], s));
  });
}

/**
 * Validación cruzada estratificada de k pliegues, repetida `reps` veces con
 * particiones distintas. Devuelve el AUC de cada repetición.
 */
function repeatedKFoldAuc(Xraw, y, { k = 5, reps = 20, seed = 11, ...opts } = {}) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const shuffle = (a) => {
    const b = [...a];
    for (let i = b.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  };
  const aucs = [];
  for (let r = 0; r < reps; r += 1) {
    const fold = new Array(y.length);
    for (const cls of [0, 1]) {
      shuffle(y.map((v, i) => (v === cls ? i : -1)).filter((i) => i >= 0)).forEach((i, n) => {
        fold[i] = n % k;
      });
    }
    const pred = new Array(y.length);
    for (let f = 0; f < k; f += 1) {
      const tr = y.map((_, i) => i).filter((i) => fold[i] !== f);
      const te = y.map((_, i) => i).filter((i) => fold[i] === f);
      const sc = standardize(tr.map((i) => Xraw[i]));
      const m = fitLogistic(
        tr.map((i) => applyScale(Xraw[i], sc)),
        tr.map((i) => y[i]),
        opts,
      );
      for (const i of te) pred[i] = predictProba(m, applyScale(Xraw[i], sc));
    }
    aucs.push(auc(pred, y));
  }
  return aucs;
}

/** Intervalo bootstrap (percentiles 2,5–97,5) del AUC sobre predicciones ya obtenidas. */
function bootstrapAuc(scores, y, { reps = 2000, seed = 7 } = {}) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const vals = [];
  for (let r = 0; r < reps; r += 1) {
    const idx = y.map(() => Math.floor(rnd() * y.length));
    const v = auc(
      idx.map((i) => scores[i]),
      idx.map((i) => y[i]),
    );
    if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(vals.length * 0.025)], vals[Math.floor(vals.length * 0.975)]];
}

module.exports = {
  sigmoid,
  standardize,
  applyScale,
  fitLogistic,
  predictProba,
  auc,
  looPredictions,
  repeatedKFoldAuc,
  bootstrapAuc,
};
