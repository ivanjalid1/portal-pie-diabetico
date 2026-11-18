'use strict';

/**
 * Registro a la grilla canónica de un pie YA RECORTADO y segmentado (fondo = 0),
 * como los de la base pública de Hernández-Contreras et al. 2019 («Plantar
 * Thermogram Database for the Study of Diabetic Foot Complications», IEEE
 * Access 7, 161296; CC BY 4.0). Usa las mismas funciones de registro que el
 * portal (src/imaging/pointwise.js): centroide + eje principal + escala
 * anisótropa, remuestreo bilineal y descarte de 1 px de contorno.
 *
 * Diferencias con una toma del portal (ambos pies en un cuadro de 320 × 240):
 *  - cada pie viene en su propio recorte ajustado, así que se agrega un margen
 *    de ceros para que el pie no «toque el borde» (si no, se tomaría como
 *    cortado);
 *  - la orientación medial/lateral no se supone: se decide con los
 *    angiosomas de la base (el lado de MPA + MCA es el medial) y se espeja el
 *    pie para que el medial quede hacia +x, igual que en el portal.
 */
const { GRID, footFrame, sampleCanonical, flipX } = require('./pointwise');
const { erode } = require('./segmentation');

const MARGEN = 4;

/** Agrega un margen de `m` píxeles con 0 alrededor de una matriz w × h. */
function pad(arr, w, h, m = MARGEN) {
  const W = w + 2 * m;
  const H = h + 2 * m;
  const out = new arr.constructor(W * H);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) out[(y + m) * W + x + m] = arr[y * w + x];
  return { data: out, w: W, h: H };
}

/** Coordenada x media de los píxeles distintos de 0. */
function meanX(mask, w) {
  let s = 0;
  let n = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    s += i % w;
    n += 1;
  }
  return n ? s / n : NaN;
}

/**
 * ¿Hay que espejar el recorte para que el lado medial quede hacia +x?
 * @param {Object<string, Uint8Array>} angio máscaras {MPA, LPA, MCA, LCA}
 */
function needsFlip(angio, w) {
  const union = (a, b) => {
    const out = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i += 1) out[i] = a[i] || b[i] ? 1 : 0;
    return out;
  };
  const medial = meanX(union(angio.MPA, angio.MCA), w);
  const lateral = meanX(union(angio.LPA, angio.LCA), w);
  if (!Number.isFinite(medial) || !Number.isFinite(lateral)) return false;
  return medial < lateral;
}

/** Etiqueta (vecino más cercano) de cada celda canónica; 0 = sin etiqueta. */
function sampleLabels(labels, w, h, f) {
  const out = new Uint8Array(GRID.w * GRID.h);
  for (let r = 0; r < GRID.h; r += 1) {
    const v = f.vTop - (r / (GRID.h - 1)) * (f.vTop - f.vBottom);
    for (let c = 0; c < GRID.w; c += 1) {
      const u = f.umin + (c / (GRID.w - 1)) * (f.umax - f.umin);
      const x = Math.round(f.cx + u * f.e2[0] + v * f.e1[0]);
      const y = Math.round(f.cy + u * f.e2[1] + v * f.e1[1]);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      out[r * GRID.w + c] = labels[y * w + x];
    }
  }
  return out;
}

const ANGIO_KEYS = Object.freeze(['MPA', 'LPA', 'MCA', 'LCA']);

/**
 * Pie recortado → grilla canónica (y, si hay angiosomas, su etiqueta por celda).
 * @param {Float32Array} T temperaturas (°C), 0 = fondo
 * @param {number} w
 * @param {number} h
 * @param {{angio?: Object<string, Uint8Array>, flip?: boolean}} opts
 * @returns {{grid: Float32Array, labels: Uint8Array|null, flipped: boolean, area: number}}
 */
function canonicalFromCrop(T, w, h, { angio = null, flip = null } = {}) {
  const espejar = flip ?? (angio ? needsFlip(angio, w) : false);
  const t0 = espejar ? flipX(T, w, h) : T;
  const P = pad(t0, w, h);
  const mask = new Uint8Array(P.data.length);
  let area = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (P.data[i] > 0) {
      mask[i] = 1;
      area += 1;
    }
  }
  if (area < 50) return { grid: new Float32Array(GRID.w * GRID.h).fill(NaN), labels: null, flipped: espejar, area };
  const fr = footFrame(mask, P.w, P.h);
  const f = { ...fr, vTop: fr.vmax, vBottom: fr.vmin };
  const grid = sampleCanonical(P.data, erode(mask, P.w, P.h), P.w, P.h, f);
  let labels = null;
  if (angio) {
    const lab = new Uint8Array(w * h);
    ANGIO_KEYS.forEach((k, j) => {
      const m = angio[k];
      if (!m) return;
      for (let i = 0; i < lab.length; i += 1) if (m[i]) lab[i] = j + 1;
    });
    const l0 = espejar ? flipX(lab, w, h) : lab;
    const PL = pad(l0, w, h);
    labels = sampleLabels(PL.data, PL.w, PL.h, f);
    for (let i = 0; i < labels.length; i += 1) if (!Number.isFinite(grid[i])) labels[i] = 0;
  }
  return { grid, labels, flipped: espejar, area };
}

/** CSV numérico (filas separadas por salto de línea, valores por coma) → matriz. */
function parseCsvMatrix(text) {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const h = rows.length;
  const w = h ? rows[0].split(',').length : 0;
  const data = new Float32Array(w * h);
  rows.forEach((l, y) => {
    const vals = l.split(',');
    if (vals.length !== w) throw new Error('CSV irregular');
    for (let x = 0; x < w; x += 1) {
      const v = Number(vals[x]);
      data[y * w + x] = Number.isFinite(v) ? v : 0;
    }
  });
  return { data, w, h };
}

module.exports = { canonicalFromCrop, needsFlip, sampleLabels, parseCsvMatrix, pad, ANGIO_KEYS, MARGEN };
