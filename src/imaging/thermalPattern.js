'use strict';

/**
 * Features térmicas INVARIANTES a la adquisición, sobre las grillas
 * canónicas de ambos pies (src/imaging/pointwise.js; el derecho ya espejado).
 *
 * Por qué: las temperaturas absolutas dependen de la cámara, la conversión a
 * °C (aproximada en el portal), el ambiente, el día y el centro. Un modelo
 * entrenado con temperaturas absolutas aprende esas condiciones (ver
 * docs/arquitectura.md §8.5) y no se puede trasladar de una base a otra. Estas
 * features sólo usan:
 *  - diferencias dentro del mismo sujeto y la misma imagen (ΔT contralateral);
 *  - temperaturas RELATIVAS a la mediana de cada pie (T − mediana): el patrón
 *    térmico (p. ej. el «patrón mariposa» de los controles) sin el nivel;
 *  - la dispersión dentro del pie.
 * Un corrimiento constante de la escala (offset) no cambia ninguna. Una
 * ganancia distinta escala las relativas por igual; por eso se informa
 * también la versión dividida por el rango intercuartil (`...Z`).
 *
 * `nivel` (mediana absoluta) se calcula sólo para comparar: NO es invariante
 * y no se usa en el modelo del portal.
 */
const { GRID, zonaDeFila, asymmetryMetrics } = require('./pointwise');
const { cellAngiosoma, ANGIOSOMAS } = require('./tci');

const valid = Number.isFinite;

function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

/** Features de un pie (o null si tiene menos de 200 celdas con dato). */
function footPattern(g) {
  const vals = [];
  for (const v of g) if (valid(v)) vals.push(v);
  if (vals.length < 200) return null;
  vals.sort((a, b) => a - b);
  const med = quantile(vals, 0.5);
  const iqr = Math.max(0.05, quantile(vals, 0.75) - quantile(vals, 0.25));
  const angio = Object.fromEntries(ANGIOSOMAS.map((a) => [a.key, []]));
  const zonas = { dedos: [], talon: [] };
  for (let r = 0; r < GRID.h; r += 1) {
    const z = zonaDeFila(r).key;
    for (let c = 0; c < GRID.w; c += 1) {
      const v = g[r * GRID.w + c];
      if (!valid(v)) continue;
      const rel = v - med;
      angio[cellAngiosoma(r, c).key].push(rel);
      if (zonas[z]) zonas[z].push(rel);
    }
  }
  const out = {
    nivel: med,
    iqr,
    rango90: quantile(vals, 0.95) - quantile(vals, 0.05),
    dedosRel: zonas.dedos.length >= 20 ? mean(zonas.dedos) : NaN,
    talonRel: zonas.talon.length >= 20 ? mean(zonas.talon) : NaN,
  };
  for (const a of ANGIOSOMAS) out[`rel${a.key}`] = angio[a.key].length >= 20 ? mean(angio[a.key]) : NaN;
  return out;
}

/** Promedio de dos valores ignorando los no finitos. */
function avg2(a, b) {
  const v = [a, b].filter(valid);
  return v.length ? mean(v) : NaN;
}

/** Claves de las features invariantes (las que usa el modelo de patrón). */
const INVARIANT_KEYS = Object.freeze([
  'relMPA',
  'relLPA',
  'relMCA',
  'relLCA',
  'dedosRel',
  'talonRel',
  'iqr',
  'rango90',
  'relMPAZ',
  'relLPAZ',
  'relMCAZ',
  'relLCAZ',
  'difNivel',
  'asimPatron',
  'areaCalientePct',
  'mediaAbs',
  'p95Abs',
]);

const r3 = (v) => (valid(v) ? Math.round(v * 1000) / 1000 : null);

/**
 * Features de una toma (ambos pies). Valores no calculables → null.
 * @param {Float32Array} izq
 * @param {Float32Array} der
 * @param {{umbralPixel?: number}} opts
 */
function patternFeatures(izq, der, { umbralPixel = 1 } = {}) {
  const fi = footPattern(izq);
  const fd = footPattern(der);
  if (!fi && !fd) return null;
  const pies = [fi, fd].filter(Boolean);
  const f = {};
  for (const k of ['iqr', 'rango90', 'dedosRel', 'talonRel', 'relMPA', 'relLPA', 'relMCA', 'relLCA', 'nivel']) {
    f[k] = pies.length === 2 ? avg2(fi[k], fd[k]) : pies[0][k];
  }
  for (const a of ANGIOSOMAS) {
    const z = pies.map((p) => p[`rel${a.key}`] / p.iqr).filter(valid);
    f[`rel${a.key}Z`] = z.length ? mean(z) : NaN;
  }
  // Contralateral (requiere ambos pies).
  f.difNivel = fi && fd ? Math.abs(fi.nivel - fd.nivel) : NaN;
  if (fi && fd) {
    const d = [];
    for (let i = 0; i < izq.length; i += 1) {
      if (valid(izq[i]) && valid(der[i])) d.push(Math.abs(izq[i] - fi.nivel - (der[i] - fd.nivel)));
    }
    f.asimPatron = d.length >= 200 ? mean(d) : NaN;
    const m = asymmetryMetrics(izq, der, { umbralPixel });
    f.areaCalientePct = m ? m.areaCalientePct : NaN;
    f.mediaAbs = m ? m.mediaAbs : NaN;
    f.p95Abs = m ? m.p95Abs : NaN;
  } else {
    f.asimPatron = NaN;
    f.areaCalientePct = NaN;
    f.mediaAbs = NaN;
    f.p95Abs = NaN;
  }
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, r3(v)]));
}

module.exports = { patternFeatures, footPattern, INVARIANT_KEYS };
