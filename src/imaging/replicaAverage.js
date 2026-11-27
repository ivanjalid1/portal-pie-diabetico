'use strict';

/**
 * Promedio de réplicas de una toma.
 *
 * Cambiar entre réplicas igual de buenas movía mucho las métricas (p. ej. el
 * área caliente de una toma pasaba de 34 % a 51 % según la foto elegida). Por
 * eso el resultado punto a punto de cada toma usa la MEDIA píxel a píxel de
 * las grillas canónicas por pie (40 × 100) de todas las réplicas que pasan
 * los criterios de encuadre y segmentación (sin banderas graves: C1–C6, C8,
 * C13; src/imaging/photoQuality.js).
 *
 * - Una celda se promedia sólo entre las réplicas que la midieron: no se
 *   rellena nada (si ninguna la midió queda sin dato).
 * - Si ninguna réplica pasa, se usa la mejor sola y la toma queda con
 *   «calidad baja».
 * - Nunca se modifican temperaturas de una réplica: sólo se promedian.
 */
const { esGrave } = require('./photoQuality');

const valid = (v) => typeof v === 'number' && !Number.isNaN(v);

/**
 * Media celda a celda de varias grillas del mismo tamaño, ignorando NaN.
 * @param {Float32Array[]} grids
 * @returns {Float32Array} NaN donde ninguna grilla tiene dato
 */
function meanGrid(grids) {
  if (!grids.length) throw new Error('meanGrid: sin grillas');
  const n = grids[0].length;
  if (grids.some((g) => g.length !== n)) throw new Error('meanGrid: grillas de distinto tamaño');
  const out = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i += 1) {
    let s = 0;
    let k = 0;
    for (const g of grids) {
      if (valid(g[i])) {
        s += g[i];
        k += 1;
      }
    }
    if (k) out[i] = s / k;
  }
  return out;
}

/** ¿La réplica pasa los criterios de encuadre y segmentación (ninguna bandera grave)? */
const pasaCriterios = (c) => Array.isArray(c.banderas) && !c.banderas.some(esGrave);

/**
 * Réplicas a promediar de una toma.
 * @param {Array<{rep:number, banderas?:string[]}>} cands réplicas segmentadas
 * @param {object} mejor la mejor réplica (respaldo si ninguna pasa)
 * @returns {{usadas: object[], promedio: boolean}}
 */
function replicasParaPromedio(cands, mejor) {
  const ok = cands.filter(pasaCriterios).sort((a, b) => a.rep - b.rep);
  if (ok.length) return { usadas: ok, promedio: true };
  return { usadas: mejor ? [mejor] : [], promedio: false };
}

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

/** Desvío estándar muestral (n − 1); null con menos de dos valores. */
function sd(values) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return null;
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

/**
 * Estabilidad entre réplicas: cuánto cambian las métricas de una réplica a
 * otra (desvío estándar y rango del área caliente y del ΔT máximo).
 * @param {Array<{metricas: {areaCalientePct:number, maxAbs:number}|null}>} porReplica
 */
function estabilidad(porReplica) {
  const area = porReplica.map((m) => m?.areaCalientePct).filter(Number.isFinite);
  const max = porReplica.map((m) => m?.maxAbs).filter(Number.isFinite);
  if (area.length < 2) return null;
  const s = sd(area);
  const sm = sd(max);
  return {
    areaCalienteDe: s === null ? null : r1(s),
    areaCalienteMin: r1(Math.min(...area)),
    areaCalienteMax: r1(Math.max(...area)),
    deltaMaxDe: sm === null ? null : r2(sm),
  };
}

/**
 * Promedio de una toma.
 * @param {Array<{rep:number, banderas?:string[], cf:{izq:Float32Array, der:Float32Array}}>} cands
 * @param {object} mejor réplica elegida (respaldo)
 * @param {{metricas?: (izq:Float32Array, der:Float32Array) => object|null}} opts
 *   `metricas`: métricas de asimetría de una réplica, para la estabilidad.
 * @returns {{izq: Float32Array, der: Float32Array, info: {n:number, promedio:boolean, reps:number[], estabilidad:object|null}}}
 */
function promediarToma(cands, mejor, { metricas = null } = {}) {
  const { usadas, promedio } = replicasParaPromedio(cands, mejor);
  if (!usadas.length) throw new Error('promediarToma: sin réplicas');
  const izq = usadas.length === 1 ? usadas[0].cf.izq : meanGrid(usadas.map((c) => c.cf.izq));
  const der = usadas.length === 1 ? usadas[0].cf.der : meanGrid(usadas.map((c) => c.cf.der));
  const est = metricas && usadas.length > 1 ? estabilidad(usadas.map((c) => metricas(c.cf.izq, c.cf.der))) : null;
  return {
    izq,
    der,
    info: { n: usadas.length, promedio, reps: usadas.map((c) => c.rep + 1), estabilidad: est },
  };
}

module.exports = { meanGrid, pasaCriterios, replicasParaPromedio, estabilidad, promediarToma, sd };
