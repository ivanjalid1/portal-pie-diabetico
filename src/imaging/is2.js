'use strict';

/**
 * Decodificador del archivo .IS2 de Fluke (cámaras Ti/TiS).
 *
 * El .IS2 es un ZIP. La imagen infrarroja está en `Images/Main/IR.data`: una
 * matriz de 320 × 241 valores uint16 little-endian, cuya primera fila (640
 * bytes) es una cabecera. Los valores son cuentas crudas del sensor (sin
 * calibrar a °C): sirven para la visualización relativa y la comparación
 * izquierda/derecha, pero la temperatura absoluta requiere los parámetros de
 * calibración del equipo.
 *
 * Sólo se usa la matriz IR: se ignoran a propósito las fotos visibles y las
 * miniaturas (que pueden incluir texto con fecha, hora y datos del equipo).
 */
const { readZip } = require('./zip');

const WIDTH = 320;
const HEIGHT = 240;
const HEADER_BYTES = WIDTH * 2;

/** @returns {{ width: number, height: number, data: Uint16Array }} */
function decodeIs2(buffer) {
  const zip = readZip(buffer);
  const key = [...zip.keys()].find((k) => /(^|\/)Images\/Main\/IR\.data$/i.test(k));
  if (!key) throw new Error('El archivo IS2 no contiene Images/Main/IR.data');
  const raw = zip.get(key)();
  const expected = HEADER_BYTES + WIDTH * HEIGHT * 2;
  if (raw.length < expected) throw new Error(`IR.data con tamaño inesperado (${raw.length} B)`);
  const data = new Uint16Array(WIDTH * HEIGHT);
  for (let i = 0; i < data.length; i += 1) data[i] = raw.readUInt16LE(HEADER_BYTES + i * 2);
  return { width: WIDTH, height: HEIGHT, data };
}

/** Percentil de un arreglo numérico (copia ordenada). */
function percentile(values, p) {
  const sorted = Float64Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

module.exports = { decodeIs2, percentile, WIDTH, HEIGHT };
