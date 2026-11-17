'use strict';

/**
 * Ayudas de presentación del análisis punto a punto (las usan las vistas):
 * arma el JSON que dibuja public/js/pointwise.js y textos en lenguaje simple.
 */
const { decodeGrid } = require('../imaging/pointwise');
const { zonasTexto, ZONA_NOMBRES } = require('../services/predictors/pointwiseAnalysis');
const thermal = require('./thermal');

/** LUT High Contrast reducida a 64 colores (para el navegador). */
const LUT = (() => {
  const fn = thermal.PALETTES.alto_contraste.fn;
  return Array.from({ length: 64 }, (_, i) => fn(i / 63));
})();

function rangeOf(tomas) {
  const vals = [];
  for (const t of tomas) {
    for (const g of [t.izq, t.der]) for (const v of decodeGrid(g)) if (Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return { lo: 24, hi: 35 };
  vals.sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
  return { lo: Math.round(q(0.02) * 10) / 10, hi: Math.round(q(0.98) * 10) / 10 };
}

/** Datos mínimos para dibujar los mapas (grillas, zonas excluidas, métricas, umbrales, LUT). */
function payload(a) {
  const p = a?.puntual;
  if (!p) return null;
  return {
    grilla: p.grilla,
    umbralPixel: p.umbralPixel,
    umbralCambio: p.umbralCambio,
    rango: rangeOf(p.tomas),
    lut: LUT,
    tomas: p.tomas.map((t) => ({
      toma: t.toma,
      izq: t.izq,
      der: t.der,
      zonasNoAnalizadas: t.zonasNoAnalizadas,
      metricas: t.metricas ? { hotspot: t.metricas.hotspot } : null,
    })),
  };
}

/** JSON seguro para incrustar en <script type="application/json">. */
const json = (obj) => JSON.stringify(obj).replace(/</g, '\u003c');

const LADO = { medial: 'interno', lateral: 'externo' };

/** «metatarso (lado interno) del pie izquierdo» */
function hotspotTexto(m) {
  if (!m?.hotspot) return '';
  const h = m.hotspot;
  return `${ZONA_NOMBRES[h.zona]} (lado ${LADO[h.lado]}), más caliente el pie ${h.pieMasCaliente}`;
}

module.exports = { payload, json, zonasTexto, hotspotTexto, ZONA_NOMBRES, LUT, rangeOf };
