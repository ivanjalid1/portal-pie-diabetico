'use strict';

/**
 * Ayudas de presentación del análisis punto a punto (las usan las vistas):
 * arma el JSON que dibuja public/js/pointwise.js y textos en lenguaje simple.
 */
const { decodeGrid, zonaDeFila, GRID } = require('../imaging/pointwise');
const { zonasTexto, ZONA_NOMBRES } = require('../services/predictors/pointwiseAnalysis');
const thermal = require('./thermal');
const { fmt } = require('./format');

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

/** «los dedos», «el metatarso»… (para frases en lenguaje simple). */
const ZONA_CON_ARTICULO = Object.freeze({
  dedos: 'los dedos',
  metatarso: 'el metatarso',
  arco: 'el arco',
  talon: 'el talón',
});

const pct1 = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const numEs = (v, dec = 0) => fmt.num(v, dec);

/**
 * Lectura en lenguaje simple de una toma: qué parte de la planta difiere más
 * que el umbral, qué pie está más caliente y en qué zona se concentra.
 * Se calcula sobre la misma grilla y las mismas zonas excluidas que las métricas.
 */
function lecturaToma(t, umbral) {
  if (!t?.metricas || !t.izq || !t.der) return null;
  const izq = decodeGrid(t.izq);
  const der = decodeGrid(t.der);
  const excl = t.zonasNoAnalizadas || [];
  const porZona = {};
  let n = 0;
  let calIzq = 0;
  let calDer = 0;
  for (let i = 0; i < izq.length; i += 1) {
    const zona = zonaDeFila(Math.floor(i / GRID.w)).key;
    if (excl.includes(zona) || !Number.isFinite(izq[i]) || !Number.isFinite(der[i])) continue;
    n += 1;
    const d = izq[i] - der[i];
    if (Math.abs(d) <= umbral) continue;
    const z = (porZona[zona] ||= { izq: 0, der: 0 });
    if (d > 0) {
      calIzq += 1;
      z.izq += 1;
    } else {
      calDer += 1;
      z.der += 1;
    }
  }
  const pct = t.metricas.areaCalientePct;
  const pctIzq = pct1(calIzq, n);
  const pctDer = pct1(calDer, n);
  const pie = calIzq >= 2 * calDer && calIzq > 0 ? 'izquierdo' : calDer >= 2 * calIzq && calDer > 0 ? 'derecho' : null;
  const cuenta = (z) => (pie === 'izquierdo' ? z.izq : pie === 'derecho' ? z.der : z.izq + z.der);
  const total = Object.values(porZona).reduce((s, z) => s + cuenta(z), 0);
  const [zonaTop, zTop] = Object.entries(porZona).sort((a, b) => cuenta(b[1]) - cuenta(a[1]))[0] || [null, null];
  const zona = zTop && total && cuenta(zTop) / total >= 0.45 ? zonaTop : null;
  const u = numEs(umbral, 1);
  const donde = zona ? `, sobre todo en ${ZONA_CON_ARTICULO[zona]}` : ', repartido en varias zonas';
  let frase;
  if (pct < 1) {
    frase = `Los dos pies tienen temperaturas parecidas: menos del 1 % de la planta difiere más de ${u} °C.`;
  } else if (pie) {
    const otro = pie === 'izquierdo' ? 'derecho' : 'izquierdo';
    const p = pie === 'izquierdo' ? pctIzq : pctDer;
    frase = `El ${numEs(p, 0)} % de la planta del pie ${pie} está más de ${u} °C más caliente que el ${otro}${donde}.`;
  } else {
    frase = `El ${numEs(pct, 0)} % de la planta difiere más de ${u} °C entre los pies (${numEs(pctIzq, 0)} % más caliente el izquierdo y ${numEs(pctDer, 0)} % el derecho)${donde}.`;
  }
  return { pct, pctIzq, pctDer, pie, zona, frase };
}

/** «no se analizaron los dedos», «no se analizó el talón» (o null si se analizó todo). */
function noAnalizadoTexto(t) {
  const zs = t?.zonasNoAnalizadas || [];
  if (!zs.length) return null;
  const l = zs.map((k) => ZONA_CON_ARTICULO[k]);
  const txt = l.length > 1 ? `${l.slice(0, -1).join(', ')} y ${l.at(-1)}` : l[0];
  return `no se ${zs.length > 1 || zs[0] === 'dedos' ? 'analizaron' : 'analizó'} ${txt}`;
}

/** Cambio del área con diferencia entre la toma 1 y la toma 2 (puntos porcentuales). */
function cambioArea(a) {
  const m1 = a?.puntualToma?.(1)?.metricas;
  const m2 = a?.puntualToma?.(2)?.metricas;
  if (!m1 || !m2) return null;
  const d = Math.round((m2.areaCalientePct - m1.areaCalientePct) * 10) / 10;
  const sentido = Math.abs(d) < 2 ? 'se mantuvo' : d > 0 ? 'aumentó' : 'disminuyó';
  return {
    delta: d,
    sentido,
    frase: `Respecto de la toma 1, el área con diferencia ${sentido} (${numEs(m1.areaCalientePct, 0)} % → ${numEs(m2.areaCalientePct, 0)} %).`,
  };
}

module.exports = {
  payload,
  json,
  zonasTexto,
  hotspotTexto,
  lecturaToma,
  noAnalizadoTexto,
  cambioArea,
  ZONA_NOMBRES,
  ZONA_CON_ARTICULO,
  LUT,
  rangeOf,
};
