'use strict';

/**
 * Condiciones ambientales de una toma y ajuste de las temperaturas ABSOLUTAS.
 *
 * En la cohorte (n = 69 tomas con ambiente medido, efectos fijos de hospital y
 * toma), la mediana plantar sube 0,45 ± 0,14 °C por cada °C de la sala y el TCI
 * absoluto 0,42 ± 0,13. Las métricas contralaterales (ΔT, área caliente,
 * alertas, pronóstico) no dependen del ambiente y NO se ajustan.
 *
 * Ajuste (sólo para mostrar temperaturas absolutas y el TCI absoluto):
 *   T_ajustada = T − 0,45 · (T_sala − 22 °C)
 * No se usa «pie − sala»: la pendiente es ≈ 0,45, no 1.
 */
const AJUSTE_AMBIENTE = Object.freeze({ pendiente: 0.45, referenciaC: 22 });

/** Estimador por el fondo del termograma (scripts/precompute-ambiente.js). */
const ESTIMADOR_FONDO = Object.freeze({ a: 0.99, b: -1.55, errorC: 0.7 });

const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Normaliza el registro de ambiente de una toma y calcula su corrección.
 * @param {{tempC?: number|null, humedad?: number|null, origen?: string}|null} a
 * @returns {{tempC:number|null, humedad:number|null, origen:'medida'|'estimada'|null, errorC:number|null, ajusteC:number|null}|null}
 */
function ambienteDeToma(a) {
  if (!a) return null;
  const tempC = Number.isFinite(a.tempC) ? a.tempC : null;
  const humedad = Number.isFinite(a.humedad) ? a.humedad : null;
  if (tempC === null && humedad === null) return null;
  const origen = a.origen === 'estimada' ? 'estimada' : 'medida';
  return {
    tempC,
    humedad,
    origen,
    errorC: origen === 'estimada' ? (a.errorC ?? ESTIMADOR_FONDO.errorC) : null,
    ajusteC: tempC === null ? null : r2(-AJUSTE_AMBIENTE.pendiente * (tempC - AJUSTE_AMBIENTE.referenciaC)),
  };
}

/** Grilla con una corrección constante (NaN se conserva). */
function shiftGrid(g, d) {
  if (!d) return g;
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i += 1) out[i] = Number.isNaN(g[i]) ? Number.NaN : g[i] + d;
  return out;
}

/** ¿Fuera del protocolo? `rangos` = settings.protocolRanges(). */
function fueraDeProtocolo(amb, rangos) {
  if (!amb || !rangos) return { temp: false, hum: false, alguno: false };
  const t = rangos.tempAmbiente;
  const h = rangos.humedadRelativa;
  const temp = amb.tempC !== null && (amb.tempC < t.min || amb.tempC > t.max);
  const hum = amb.humedad !== null && (amb.humedad < h.min || amb.humedad > h.max);
  return { temp, hum, alguno: temp || hum };
}

module.exports = { AJUSTE_AMBIENTE, ESTIMADOR_FONDO, ambienteDeToma, shiftGrid, fueraDeProtocolo };
