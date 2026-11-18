'use strict';

/**
 * Índice de cambio térmico (Thermal Change Index, TCI) sobre la grilla
 * canónica registrada (40 × 100 por pie, src/imaging/pointwise.js).
 *
 * Definición publicada (Hernández-Contreras D., Peregrina-Barreto H.,
 * Rangel-Magdaleno J., González-Bernal J., Altamirano-Robles L. «A
 * quantitative index for classification of plantar thermal changes in the
 * diabetic foot». Infrared Physics & Technology 81 (2017) 242–249):
 *
 *     TCI = ( Σ_a | CG_a − DM_a | ) / 4,   a ∈ {MPA, LPA, MCA, LCA}
 *
 * donde CG_a es la temperatura media del angiosoma a en el patrón de
 * referencia (grupo control, «patrón mariposa») y DM_a la del pie evaluado.
 * Cada pie se compara contra el patrón de referencia, no contra el otro pie.
 * Clases de la publicación: 1 (TCI ≤ 2), 2 (2–3), 3 (3–4), 4 (4–5), 5 (> 5).
 *
 * Incertidumbres (no se pudo acceder al texto completo; se verificó la
 * fórmula en trabajos que la citan): algunas reproducciones escriben la
 * fórmula sin valor absoluto; aquí se usa el valor absoluto, que es lo que
 * describe la mayoría y lo que da sentido a las clases (TCI ≥ 0). El TCI del
 * estudio es el promedio de ambos pies; también se informa el de cada pie.
 *
 * Adaptaciones de este portal (documentadas en docs/arquitectura.md §8.4):
 *  - Angiosomas por ATLAS: cada celda de la grilla canónica toma la etiqueta
 *    mayoritaria de los angiosomas de la base pública de 2019, registrados a
 *    la misma grilla (src/config/models/angiosome-atlas.json, generado por
 *    scripts/ml/export-public.js). En las celdas del borde sin etiqueta se usa
 *    la etiqueta más cercana de la misma fila. Si falta el atlas, se usa la
 *    aproximación geométrica: MPA = mitad medial de 0–70 % del largo, LPA =
 *    mitad lateral, MCA / LCA = mitades medial / lateral del talón.
 *  - Versión PUNTO A PUNTO: desvío por celda D = T(pie) − T(referencia) y
 *    TCI puntual = media de |D| en las celdas con dato. El mapa D es el «mapa
 *    de desvío» que se muestra.
 *  - Referencia: el grupo control de la base pública (ver `REFERENCE_SOURCES`).
 *    Con la referencia de la cohorte, al calcular el TCI de un paciente que la
 *    integra se lo excluye (leave-one-out) para no compararlo consigo.
 *  - La cámara y la escala de temperatura de la base pública no son las del
 *    portal (cuentas → °C aproximado): el TCI absoluto arrastra esa diferencia
 *    de nivel. Por eso se informa también el TCI «de patrón», que descuenta la
 *    mediana de cada pie y no depende del nivel.
 */
const { GRID } = require('./pointwise');

/** Angiosomas aproximados: [clave, desde, hasta (fracción del largo), lado]. */
const ANGIOSOMAS = Object.freeze([
  Object.freeze({ key: 'MPA', nombre: 'arteria plantar medial', desde: 0, hasta: 0.7, lado: 'medial' }),
  Object.freeze({ key: 'LPA', nombre: 'arteria plantar lateral', desde: 0, hasta: 0.7, lado: 'lateral' }),
  Object.freeze({ key: 'MCA', nombre: 'arteria calcánea medial', desde: 0.7, hasta: 1.01, lado: 'medial' }),
  Object.freeze({ key: 'LCA', nombre: 'arteria calcánea lateral', desde: 0.7, hasta: 1.01, lado: 'lateral' }),
]);

/** Clases de la publicación (límite superior inclusive). */
const CLASES = Object.freeze([
  { clase: 1, hasta: 2 },
  { clase: 2, hasta: 3 },
  { clase: 3, hasta: 4 },
  { clase: 4, hasta: 5 },
  { clase: 5, hasta: Infinity },
]);

/**
 * Fuentes del patrón de referencia. Por defecto, el grupo control (45
 * sujetos sin diabetes) de la base pública de Hernández-Contreras et al.
 * (2019, «Plantar Thermogram Database for the Study of Diabetic Foot
 * Complications», IEEE Access 7, 161296; CC BY 4.0), registrado a esta misma
 * grilla canónica (scripts/ml/export-public.js). Si la base no está en local,
 * los pacientes más simétricos de la cohorte.
 */
const REFERENCE_SOURCES = Object.freeze({
  cohorte: 'Pacientes más simétricos de la cohorte (|ΔT general| < 1 °C en la planilla y área caliente baja)',
  hernandez2019:
    'Grupo control (45 sujetos sin diabetes) de la base pública Hernández-Contreras et al. 2019, registrado a la grilla canónica',
});

/** Fracción mínima de miembros con dato para usar una celda de la referencia. */
const COBERTURA_REFERENCIA = 0.3;
/** Celdas mínimas por angiosoma para promediarlo. */
const CELDAS_MINIMAS = 20;

const valid = Number.isFinite;

/** Aproximación geométrica (sin atlas). */
const geometricAngiosoma = (r, c) => {
  const f = r / (GRID.h - 1);
  const medial = c >= GRID.w / 2;
  return ANGIOSOMAS.find((a) => f >= a.desde && f < a.hasta && (a.lado === 'medial') === medial) || null;
};

const ATLAS_KEYS = [null, 'MPA', 'LPA', 'MCA', 'LCA'];

/** Tabla celda → angiosoma desde el atlas (o null si no está o es inválido). */
function loadAtlas() {
  let doc;
  try {
    doc = require('../config/models/angiosome-atlas.json');
  } catch {
    return null;
  }
  const filas = doc?.filas;
  if (!Array.isArray(filas) || filas.length !== GRID.h || filas.some((f) => f.length !== GRID.w)) return null;
  const byKey = Object.fromEntries(ANGIOSOMAS.map((a) => [a.key, a]));
  const table = new Array(GRID.w * GRID.h).fill(null);
  for (let r = 0; r < GRID.h; r += 1) {
    const row = filas[r];
    for (let c = 0; c < GRID.w; c += 1) {
      let k = Number(row[c]);
      // Borde sin etiqueta: la más cercana de la misma fila.
      for (let d = 1; !k && d < GRID.w; d += 1) k = Number(row[c - d] || 0) || Number(row[c + d] || 0);
      table[r * GRID.w + c] = k ? byKey[ATLAS_KEYS[k]] : geometricAngiosoma(r, c);
    }
  }
  return { table, acuerdoMedio: doc.acuerdoMedio ?? null, pies: doc.pies ?? null };
}

const ATLAS = loadAtlas();
/** Cómo se ubican los angiosomas en la grilla (se informa en el detalle técnico). */
const ANGIOSOMA_METODO = ATLAS
  ? `atlas de la base pública 2019 (${ATLAS.pies} pies registrados, acuerdo medio ${String(ATLAS.acuerdoMedio).replace('.', ',')})`
  : 'aproximación geométrica';

const cellAngiosoma = (r, c) => (ATLAS ? ATLAS.table[r * GRID.w + c] : geometricAngiosoma(r, c));

/**
 * Patrón de referencia por celda: promedio de ambos pies (el derecho ya está
 * espejado) de todos los miembros, salvo `exclude`.
 * @param {Array<{id:string, izq:Float32Array, der:Float32Array}>} members
 * @param {{exclude?:string, fuente?:string}} opts
 */
function buildReference(members, { exclude = null, fuente = 'cohorte' } = {}) {
  const usados = members.filter((m) => m.id !== exclude);
  const n = GRID.w * GRID.h;
  const sum = new Float64Array(n);
  const cnt = new Uint16Array(n);
  for (const m of usados) {
    for (const g of [m.izq, m.der]) {
      for (let i = 0; i < n; i += 1) {
        if (valid(g[i])) {
          sum[i] += g[i];
          cnt[i] += 1;
        }
      }
    }
  }
  const minimo = Math.max(2, Math.ceil(COBERTURA_REFERENCIA * usados.length * 2));
  const mean = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i += 1) if (cnt[i] >= minimo) mean[i] = sum[i] / cnt[i];
  return { mean, miembros: usados.length, fuente, excluido: exclude !== null && usados.length < members.length };
}

function angiosomeMeans(g, ref) {
  const acc = Object.fromEntries(ANGIOSOMAS.map((a) => [a.key, { s: 0, r: 0, n: 0 }]));
  for (let r = 0; r < GRID.h; r += 1) {
    for (let c = 0; c < GRID.w; c += 1) {
      const i = r * GRID.w + c;
      if (!valid(g[i]) || !valid(ref[i])) continue;
      const a = cellAngiosoma(r, c);
      if (!a) continue;
      acc[a.key].s += g[i];
      acc[a.key].r += ref[i];
      acc[a.key].n += 1;
    }
  }
  return acc;
}

const r2 = (v) => (valid(v) ? Math.round(v * 100) / 100 : null);

/** TCI de un pie contra el patrón (null si quedan menos de 2 angiosomas con dato). */
function tciFoot(g, ref) {
  const acc = angiosomeMeans(g, ref);
  const porAngiosoma = {};
  const difs = [];
  for (const a of ANGIOSOMAS) {
    const x = acc[a.key];
    if (x.n < CELDAS_MINIMAS) {
      porAngiosoma[a.key] = null;
      continue;
    }
    const d = x.s / x.n - x.r / x.n;
    porAngiosoma[a.key] = r2(d);
    difs.push(Math.abs(d));
  }
  if (difs.length < 2) return { tci: null, porAngiosoma };
  return { tci: difs.reduce((s, v) => s + v, 0) / difs.length, porAngiosoma };
}

/** Mapa de desvío punto a punto D = T(pie) − T(referencia) (NaN sin dato). */
function deviationGrid(g, ref) {
  const out = new Float32Array(g.length).fill(NaN);
  for (let i = 0; i < g.length; i += 1) if (valid(g[i]) && valid(ref[i])) out[i] = g[i] - ref[i];
  return out;
}

function claseTci(v) {
  if (!valid(v)) return null;
  return CLASES.find((c) => v <= c.hasta).clase;
}

/**
 * TCI de una toma (ambos pies) contra un patrón de referencia.
 * @param {Float32Array} izq grilla canónica del pie izquierdo
 * @param {Float32Array} der grilla canónica del pie derecho (espejado)
 * @param {{mean:Float32Array, miembros:number, fuente:string, excluido:boolean}} reference
 */
function computeTci(izq, der, reference) {
  if (!reference?.mean || !reference.miembros) return null;
  const ref = reference.mean;
  const fi = tciFoot(izq, ref);
  const fd = tciFoot(der, ref);
  const porPie = [fi.tci, fd.tci].filter(valid);
  if (!porPie.length) return null;
  const devI = deviationGrid(izq, ref);
  const devD = deviationGrid(der, ref);
  const abs = [];
  const signed = [];
  for (const d of [devI, devD]) {
    for (const v of d) {
      if (valid(v)) {
        abs.push(Math.abs(v));
        signed.push(v);
      }
    }
  }
  abs.sort((a, b) => a - b);
  const valor = porPie.reduce((s, v) => s + v, 0) / porPie.length;
  // Variante «de patrón»: descuenta el nivel general de cada pie (ambiente,
  // calibración) y mide sólo la forma del mapa respecto de la referencia.
  const mediana = (arr) => {
    const s = [...arr].filter(valid).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
  };
  const patron = [];
  for (const d of [devI, devD]) {
    const m = mediana(d);
    for (const v of d) if (valid(v)) patron.push(Math.abs(v - m));
  }
  return {
    valor: r2(valor),
    clase: claseTci(valor),
    izq: r2(fi.tci),
    der: r2(fd.tci),
    angiosomas: { izq: fi.porAngiosoma, der: fd.porAngiosoma },
    puntual: r2(abs.reduce((s, v) => s + v, 0) / Math.max(1, abs.length)),
    puntualP95: r2(abs[Math.min(abs.length - 1, Math.round(0.95 * (abs.length - 1)))]),
    desvioMedio: r2(signed.reduce((s, v) => s + v, 0) / Math.max(1, signed.length)),
    patron: r2(patron.reduce((s, v) => s + v, 0) / Math.max(1, patron.length)),
    celdas: abs.length,
    mapas: { izq: devI, der: devD },
    referencia: { fuente: reference.fuente, miembros: reference.miembros, looExcluido: reference.excluido },
  };
}

module.exports = {
  ANGIOSOMAS,
  CLASES,
  REFERENCE_SOURCES,
  COBERTURA_REFERENCIA,
  buildReference,
  computeTci,
  tciFoot,
  deviationGrid,
  claseTci,
  cellAngiosoma,
  geometricAngiosoma,
  ANGIOSOMA_METODO,
};
