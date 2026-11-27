'use strict';

/**
 * Una sola foto (réplica) por toma.
 *
 * El análisis de cada toma usa UNA réplica: la elegida a mano en «Revisión de
 * fotos» o, si nadie eligió, la sugerida automáticamente por los criterios de
 * calidad (src/imaging/photoQuality.js): primero las réplicas sin banderas
 * graves y, entre ellas, la de mejor puntaje (empates: la primera captura).
 * Nunca se promedian ni se modifican temperaturas.
 *
 * El precálculo (scripts/precompute-real.js) guarda las grillas y el TCI de
 * CADA réplica (`porReplica`), así cambiar la foto de una toma sólo vuelve a
 * analizar esa toma, sin reprocesar los IS2.
 */
const { esGrave, selectReplica, EMPATE } = require('./photoQuality');

/** ¿La réplica pasa los criterios de encuadre y segmentación (ninguna bandera grave)? */
const pasaCriterios = (c) => Array.isArray(c?.banderas) && !c.banderas.some(esGrave);

/**
 * Réplica sugerida de una toma: la mejor entre las que pasan los criterios o,
 * si ninguna pasa, la menos afectada de todas.
 * @param {Array<{rep:number, puntaje:number, banderas?:string[]}>} cands
 */
function sugerirReplica(cands, { empate = EMPATE } = {}) {
  const limpias = cands.filter(pasaCriterios);
  return selectReplica(limpias.length ? limpias : cands, { empate });
}

/**
 * Calidad de las fotos de la toma con la réplica usada.
 * @param {object} base calidad de la toma del precálculo (`replicas`, `limpias`, `sugerida`…)
 * @param {{rep:number, banderas?:string[]}} replica réplica usada
 * @param {{revisor?: string|null}} opts `revisor`: quién la eligió (null = sugerida automáticamente)
 */
function calidadConReplica(base, replica, { revisor = null } = {}) {
  const banderas = Array.isArray(replica.banderas) ? replica.banderas : [];
  const sugerida = base?.sugerida ?? base?.rep ?? null;
  return {
    replicas: base?.replicas ?? null,
    limpias: base?.limpias ?? null,
    sugerida,
    rep: replica.rep,
    baja: banderas.some(esGrave),
    banderas,
    elegidaPor: revisor || null,
    // Contorno de los pies corregido a mano en esa foto (src/services/MaskCorrectionService.js).
    contornoPor: replica.contorno?.por || null,
  };
}

/**
 * Toma del análisis (hints del predictor) con otra réplica: sus grillas, su
 * TCI, su calidad de registro y su marco; conserva la fecha y el ambiente de la
 * toma.
 * @param {object} toma toma del análisis vigente (`puntual.tomas[i]`)
 * @param {object} replica entrada de `porReplica` (izq, der, tci, calidad, marco, segmentacion, banderas)
 */
function tomaConReplica(toma, replica, { revisor = null } = {}) {
  return {
    ...toma,
    izq: replica.izq,
    der: replica.der,
    tci: replica.tci ?? null,
    calidad: replica.calidad ?? null,
    marco: replica.marco ?? null,
    segmentacion: replica.segmentacion ?? toma.segmentacion,
    // Sin TCI precalculado (contorno corregido) el predictor lo recalcula con la referencia.
    calidadFotos: calidadConReplica(toma.calidadFotos, replica, { revisor }),
  };
}

/**
 * Texto de la foto usada en una toma: «Foto 2 de 3 · elegida por Nombre» o
 * «Foto 1 de 3 · sugerida automáticamente».
 * @returns {null|{rep:number, n:number|null, corto:string, origen:string, manual:boolean}}
 */
function fotoUsada(t) {
  const q = t?.calidadFotos;
  if (!q || !Number.isFinite(q.rep)) return null;
  const n = Number.isFinite(q.replicas) ? q.replicas : null;
  const manual = Boolean(q.elegidaPor);
  const origen = manual ? `elegida por ${q.elegidaPor}` : 'sugerida automáticamente';
  return {
    rep: q.rep,
    n,
    manual,
    origen,
    contornoPor: q.contornoPor || null,
    corto: `Foto ${q.rep}${n ? ` de ${n}` : ''} · ${origen}${q.contornoPor ? ` · contorno corregido por ${q.contornoPor}` : ''}`,
  };
}

module.exports = { pasaCriterios, sugerirReplica, calidadConReplica, tomaConReplica, fotoUsada };
