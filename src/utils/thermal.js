'use strict';

/**
 * Escalas de color térmicas.
 *  - IRONBOW: paleta clásica de las cámaras Fluke (imágenes demo).
 *  - HIGH_CONTRAST: similar a la paleta «High Contrast» de Fluke (azul →
 *    cian → verde → amarillo → rojo → blanco). Se usa en el mapa plantar
 *    porque separa mejor diferencias pequeñas de ΔT.
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

/**
 * Paleta «High Contrast» de Fluke (la configurada en la cámara del estudio).
 * LUT de 256 colores derivada empíricamente del render de la cámara (ver
 * src/config/palettes/high-contrast.json y docs/despliegue.md).
 */
const HIGH_CONTRAST = require('../config/palettes/high-contrast.json').lut.map((c, i) => [i / 255, c]);

const GRAYS = [
  [0, [0, 0, 0]],
  [1, [255, 255, 255]],
];

function interpolate(stops, t) {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i += 1) {
    const [p1, c1] = stops[i];
    const [p0, c0] = stops[i - 1];
    if (x <= p1) {
      const k = (x - p0) / (p1 - p0);
      return c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
    }
  }
  return stops.at(-1)[1];
}

const ironbow = (t) => interpolate(IRONBOW, t);
const HC_LUT = HIGH_CONTRAST.map(([, c]) => c);
/** Búsqueda directa en la LUT de 256 entradas (rápida para renderizar). */
const highContrast = (t) => HC_LUT[Math.max(0, Math.min(255, Math.round((Number.isFinite(t) ? t : 0) * 255)))];
const grays = (t) => interpolate(GRAYS, t);

/** Paletas disponibles para renderizar termogramas (la primera es la predeterminada). */
const PALETTES = Object.freeze({
  alto_contraste: Object.freeze({ key: 'alto_contraste', nombre: 'High Contrast', fn: highContrast, stops: HIGH_CONTRAST }),
  ironbow: Object.freeze({ key: 'ironbow', nombre: 'Ironbow', fn: ironbow, stops: IRONBOW }),
  grises: Object.freeze({ key: 'grises', nombre: 'Escala de grises', fn: grays, stops: GRAYS }),
});
const DEFAULT_PALETTE = 'alto_contraste';

/** Rango térmico fijo de la cámara en el protocolo (modo manual 24–35 °C). */
const CAMERA_RANGE = Object.freeze({ min: 24, max: 35 });

const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** Gradiente CSS de una escala (para leyendas). */
function cssGradient(stops, from = 0, to = 1) {
  const step = stops.length > 32 ? Math.ceil(stops.length / 24) : 1;
  const parts = stops
    .filter(([p], i) => p >= from && p <= to && (i % step === 0 || i === stops.length - 1))
    .map(([p, c]) => `${hex(c)} ${Math.round(((p - from) / (to - from)) * 100)}%`);
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

/** Rango de la escala usado por el mapa: |ΔT| 0 °C → 0,06; 3 °C → 0,94. */
const DELTA_SCALE = Object.freeze({ from: 0.3, to: 0.88, max: 3 });

/** Color para una diferencia contralateral |ΔT| (0 °C → frío, ≥3 °C → caliente). */
function deltaColor(delta, max = DELTA_SCALE.max) {
  const k = Math.min(Math.abs(delta), max) / max;
  return hex(highContrast(DELTA_SCALE.from + k * (DELTA_SCALE.to - DELTA_SCALE.from)));
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
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#10161c' : '#ffffff';
}

const DELTA_LEGEND_CSS = cssGradient(HIGH_CONTRAST, DELTA_SCALE.from, DELTA_SCALE.to);

/** Gradiente CSS vertical/horizontal de cada paleta para la barra de escala en °C. */
const PALETTE_CSS = Object.freeze(
  Object.fromEntries(Object.values(PALETTES).map((p) => [p.key, cssGradient(p.stops, 0, 1)])),
);

module.exports = {
  ironbow,
  highContrast,
  grays,
  PALETTES,
  DEFAULT_PALETTE,
  CAMERA_RANGE,
  PALETTE_CSS,
  deltaColor,
  tempColor,
  inkOn,
  hex,
  cssGradient,
  DELTA_LEGEND_CSS,
};
