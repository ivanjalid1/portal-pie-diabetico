'use strict';

/**
 * Escala de color «ironbow» (la paleta habitual de las cámaras Fluke) usada
 * en el mapa plantar esquemático y en las imágenes demo.
 */
const IRONBOW = [
  [0.0, [16, 12, 48]],
  [0.18, [64, 18, 110]],
  [0.36, [140, 30, 120]],
  [0.52, [200, 52, 80]],
  [0.68, [236, 102, 34]],
  [0.84, [250, 172, 30]],
  [1.0, [255, 244, 190]],
];

function ironbow(t) {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < IRONBOW.length; i += 1) {
    const [p1, c1] = IRONBOW[i];
    const [p0, c0] = IRONBOW[i - 1];
    if (x <= p1) {
      const k = (x - p0) / (p1 - p0);
      return c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
    }
  }
  return IRONBOW.at(-1)[1];
}

const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** Color para una diferencia contralateral |ΔT| (0 °C → frío, ≥3 °C → caliente). */
function deltaColor(delta, max = 3) {
  return hex(ironbow(0.12 + (Math.min(Math.abs(delta), max) / max) * 0.8));
}

/** Color para una temperatura absoluta dentro del rango de la cámara. */
function tempColor(t, min = 24, max = 35) {
  return hex(ironbow((t - min) / (max - min)));
}

/** Texto legible sobre un color de fondo. */
function inkOn(hexColor) {
  const n = Number.parseInt(hexColor.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1a1320' : '#ffffff';
}

module.exports = { ironbow, deltaColor, tempColor, inkOn, hex };
