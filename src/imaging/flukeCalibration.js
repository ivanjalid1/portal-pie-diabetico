'use strict';

/**
 * Escala de color «como la cámara»: estima qué cuentas crudas corresponden a
 * los extremos del rango de la paleta (24 °C y 35 °C en el protocolo) usando la
 * miniatura que la propia cámara guarda en el IS2 (Thumbnails/014000F0.jpg).
 *
 * La miniatura se usa SÓLO como referencia de calibración en memoria: nunca se
 * guarda ni se publica (tiene impresos fecha, hora y datos del equipo).
 *
 * Método: la miniatura muestra la imagen IR escalada 0,75 con desplazamiento
 * (40, 30) px (registro verificado en 52 archivos) y mezclada con la imagen
 * visible (IR-Fusion, α≈0,75). Se toman los píxeles coloreados, se modela la
 * mezcla y se buscan los extremos (c0, c1) que minimizan la diferencia de color
 * contra la LUT High Contrast.
 */
const jpeg = require('jpeg-js');
const { readZip } = require('./zip');
const { highContrast } = require('../utils/thermal');

const GEOMETRY = Object.freeze({ scale: 0.75, dx: 40, dy: 30 });
const ALPHA = 0.75;
const GRAY = 110;

function thumbnailPixels(is2Buffer) {
  const zip = readZip(is2Buffer);
  const key = [...zip.keys()].find((k) => /Thumbnails\/[^/]+\.jpe?g$/i.test(k));
  if (!key) return null;
  return jpeg.decode(zip.get(key)(), { useTArray: true, maxMemoryUsageInMB: 64 });
}

/** @returns {{c0:number, c1:number, error:number}|null} */
function calibrateSpan(is2Buffer, ir) {
  let thumb;
  try {
    thumb = thumbnailPixels(is2Buffer);
  } catch {
    return null;
  }
  if (!thumb || thumb.width !== 320 || thumb.height !== 240) return null;
  const pts = [];
  for (let y = 40; y < 200; y += 3) {
    for (let x = 60; x < 260; x += 3) {
      if (x > 145 && x < 175 && y > 105 && y < 135) continue; // marcador central
      const i = (y * 320 + x) * 4;
      const c = [thumb.data[i], thumb.data[i + 1], thumb.data[i + 2]];
      const sat = Math.max(...c) - Math.min(...c);
      if (sat <= 45 && Math.min(...c) <= 235) continue; // fondo visible (no coloreado)
      const ix = Math.round((x - GEOMETRY.dx) / GEOMETRY.scale);
      const iy = Math.round((y - GEOMETRY.dy) / GEOMETRY.scale);
      if (ix < 0 || iy < 0 || ix >= ir.width || iy >= ir.height) continue;
      pts.push([ir.data[iy * ir.width + ix], c]);
    }
  }
  if (pts.length < 200) return null;
  const sample = pts.length > 900 ? pts.filter((_, k) => k % Math.ceil(pts.length / 900) === 0) : pts;
  const err = (c0, c1) => {
    let acc = 0;
    for (const [cnt, c] of sample) {
      const o = highContrast((cnt - c0) / (c1 - c0));
      const r = ALPHA * o[0] + (1 - ALPHA) * GRAY - c[0];
      const g = ALPHA * o[1] + (1 - ALPHA) * GRAY - c[1];
      const b = ALPHA * o[2] + (1 - ALPHA) * GRAY - c[2];
      acc += Math.sqrt(r * r + g * g + b * b);
    }
    return acc / sample.length;
  };
  let best = { error: Infinity };
  for (let c0 = 3400; c0 <= 5200; c0 += 25) {
    for (let c1 = c0 + 150; c1 <= c0 + 1800; c1 += 25) {
      const e = err(c0, c1);
      if (e < best.error) best = { error: e, c0, c1 };
    }
  }
  for (let c0 = best.c0 - 25; c0 <= best.c0 + 25; c0 += 3) {
    for (let c1 = best.c1 - 25; c1 <= best.c1 + 25; c1 += 3) {
      const e = err(c0, c1);
      if (e < best.error) best = { error: e, c0, c1 };
    }
  }
  return best;
}

module.exports = { calibrateSpan, GEOMETRY };
