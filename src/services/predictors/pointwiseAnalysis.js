'use strict';

/**
 * Análisis punto a punto a partir de las grillas canónicas ya registradas
 * (src/imaging/pointwise.js). Es puro: recibe las grillas serializadas y los
 * parámetros vigentes y devuelve el objeto `puntual` que guarda el análisis.
 * Por eso al cambiar la configuración se recalcula sin volver a procesar las
 * imágenes.
 */
const {
  GRID,
  ZONAS,
  decodeGrid,
  asymmetryMetrics,
  changeMetrics,
  zoneCoverage,
  roisFromGrids,
  encodeGrid,
} = require('../../imaging/pointwise');
const { computeTci } = require('../../imaging/tci');

/** Cobertura mínima (fracción) para considerar analizada una zona. */
const COBERTURA_MINIMA = 0.5;

const ZONA_NOMBRES = Object.freeze(Object.fromEntries(ZONAS.map((z) => [z.key, z.nombre])));

function zonasDeToma(cobertura) {
  const excluidas = ZONAS.filter((z) => (cobertura[z.key] ?? 0) < COBERTURA_MINIMA).map((z) => z.key);
  return { excluidas, analizadas: ZONAS.map((z) => z.key).filter((k) => !excluidas.includes(k)) };
}

/** TCI serializable (mapas de desvío en base64). */
function serializeTci(t) {
  if (!t) return null;
  const { mapas, ...rest } = t;
  return { ...rest, mapas: { izq: encodeGrid(mapas.izq), der: encodeGrid(mapas.der) } };
}

/**
 * @param {{toma1: object, toma2?: object|null}} grids  cada toma: { izq, der (base64), calidad?, marco?, fecha?, tci? }
 * @param {{umbralPixel:number, areaMinima:number, umbralCambio:number}} p
 * @param {{tciReference?: object}} opts  patrón de referencia del TCI (si la toma no trae su TCI precalculado)
 */
function analyzePointwise(grids, p, { tciReference = null } = {}) {
  const umbralPixel = p.umbralPixel ?? 1;
  const areaMinima = p.areaMinima ?? 10;
  const umbralCambio = p.umbralCambio ?? 1;
  const decoded = {};
  const tomas = [];
  for (const k of [1, 2]) {
    const g = grids[`toma${k}`];
    if (!g?.izq || !g?.der) continue;
    const izq = decodeGrid(g.izq);
    const der = decodeGrid(g.der);
    decoded[k] = { izq, der };
    const cobertura = zoneCoverage(izq, der);
    const { excluidas, analizadas } = zonasDeToma(cobertura);
    const metricas = asymmetryMetrics(izq, der, { umbralPixel, zonasExcluidas: excluidas });
    let tci = g.tci ?? null;
    if (!tci && tciReference) tci = serializeTci(computeTci(izq, der, tciReference));
    tomas.push({
      toma: k,
      izq: g.izq,
      der: g.der,
      segmentacion: g.segmentacion ?? 'clasica',
      tci,
      calidad: g.calidad ?? null,
      marco: g.marco ?? null,
      fecha: g.fecha ?? null,
      cobertura: Object.fromEntries(Object.entries(cobertura).map(([z, v]) => [z, Math.round(v * 100) / 100])),
      zonasNoAnalizadas: excluidas,
      zonasAnalizadas: analizadas,
      metricas,
      conAsimetria: metricas ? metricas.areaCalientePct >= areaMinima : null,
    });
  }
  let cambio = null;
  if (decoded[1] && decoded[2]) {
    cambio = {
      izq: changeMetrics(decoded[1].izq, decoded[2].izq, { umbralCambio }),
      der: changeMetrics(decoded[1].der, decoded[2].der, { umbralCambio }),
    };
  }
  const ultima = tomas.at(-1) || null;
  return {
    version: 'puntual-v1',
    grilla: { w: GRID.w, h: GRID.h },
    convencion: 'ΔT = izquierdo − derecho (espejado); positivo = pie izquierdo más caliente',
    umbralPixel,
    areaMinima,
    umbralCambio,
    tieneToma2: Boolean(decoded[2]),
    tomaActual: ultima ? ultima.toma : null,
    tomas,
    cambio,
    rois: Object.fromEntries(Object.entries(decoded).map(([k, d]) => [`toma${k}`, roisFromGrids(d.izq, d.der)])),
  };
}

/** Texto en lenguaje simple de las zonas analizadas y no analizadas de una toma. */
function zonasTexto(toma) {
  if (!toma || !toma.zonasNoAnalizadas.length) return null;
  const lista = (keys) => {
    const n = keys.map((k) => ZONA_NOMBRES[k]);
    return n.length > 1 ? `${n.slice(0, -1).join(', ')} y ${n.at(-1)}` : n[0] || '';
  };
  return {
    noAnalizado: lista(toma.zonasNoAnalizadas),
    analizado: lista(toma.zonasAnalizadas),
  };
}

module.exports = { analyzePointwise, serializeTci, zonasTexto, ZONA_NOMBRES, COBERTURA_MINIMA };
