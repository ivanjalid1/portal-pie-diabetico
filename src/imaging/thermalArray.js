'use strict';

/**
 * Matriz de temperaturas compacta para el visor de termogramas (estilo Fluke
 * SmartView), que se renderiza en el navegador sobre un canvas.
 *
 * Formato binario «TPV1» (little-endian), 153 KB para 320 × 240:
 *   0  'TPV1'           firma
 *   4  uint16 ancho
 *   6  uint16 alto
 *   8  float32 origen   °C del valor 0
 *  12  float32 paso     °C por unidad (0,01)
 *  16  uint16[ancho·alto] valores cuantizados; 0xFFFF = sin dato
 *
 * El cliente (public/js/thermo-viewer.js) lo decodifica con un DataView.
 */
const MAGIC = 'TPV1';
const HEADER = 16;
const NODATA = 0xffff;
const STEP = 0.01;

/**
 * @param {{ width: number, height: number, data: ArrayLike<number> }} img temperaturas en °C
 * @returns {Buffer}
 */
function encodeThermal({ width, height, data }, { step = STEP } = {}) {
  if (data.length !== width * height) throw new Error('encodeThermal: tamaño inconsistente');
  let min = Infinity;
  for (const v of data) if (Number.isFinite(v) && v < min) min = v;
  const origin = Number.isFinite(min) ? Math.floor(min * 10) / 10 : 0;
  const buf = Buffer.alloc(HEADER + data.length * 2);
  buf.write(MAGIC, 0, 'ascii');
  buf.writeUInt16LE(width, 4);
  buf.writeUInt16LE(height, 6);
  buf.writeFloatLE(origin, 8);
  buf.writeFloatLE(step, 12);
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    const q = Number.isFinite(v) ? Math.min(NODATA - 1, Math.max(0, Math.round((v - origin) / step))) : NODATA;
    buf.writeUInt16LE(q, HEADER + i * 2);
  }
  return buf;
}

/** @returns {{ width: number, height: number, data: Float32Array }} (NaN = sin dato) */
function decodeThermal(buf) {
  if (buf.toString('ascii', 0, 4) !== MAGIC) throw new Error('decodeThermal: firma inválida');
  const width = buf.readUInt16LE(4);
  const height = buf.readUInt16LE(6);
  const origin = buf.readFloatLE(8);
  const step = buf.readFloatLE(12);
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i += 1) {
    const q = buf.readUInt16LE(HEADER + i * 2);
    data[i] = q === NODATA ? Number.NaN : origin + q * step;
  }
  return { width, height, data };
}

/**
 * Temperaturas aproximadas a partir de un render en escala de grises con un
 * rango conocido (las imágenes demo públicas, renderizadas con la escala de la
 * cámara). Remuestrea por promedio de área al tamaño de la matriz IR.
 * @param {{ width:number, height:number, channels:number, data:Uint8Array }} png
 * @param {{ min:number, max:number }} range °C del negro y del blanco
 */
function grayToCelsius(png, range, { width = 320, height = 240 } = {}) {
  const out = new Float32Array(width * height);
  const sx = png.width / width;
  const sy = png.height / height;
  const k = (range.max - range.min) / 255;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let acc = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          acc += png.data[(yy * png.width + xx) * png.channels];
          n += 1;
        }
      }
      out[y * width + x] = range.min + (acc / n) * k;
    }
  }
  return { width, height, data: out };
}

module.exports = { encodeThermal, decodeThermal, grayToCelsius, MAGIC, NODATA, STEP };
