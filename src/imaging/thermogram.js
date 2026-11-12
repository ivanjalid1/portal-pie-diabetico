'use strict';

/**
 * Procesamiento básico de un termograma plantar (matriz de cuentas IR):
 *  - segmentación de ambos pies (umbral de Otsu + componentes conexas),
 *  - ROIs por pie (dedo mayor, dedos menores, metatarso, arco interno,
 *    arco externo, talón, general) por bandas de la longitud del pie,
 *  - renderizado en color con interpolación bicúbica y barra de escala.
 *
 * Es una aproximación para la DEMO (las ROIs reales se definirán en el
 * algoritmo de la tesis); sirve para que los valores por ROI del seed sean
 * coherentes con lo que muestra la imagen.
 */
const { ironbow } = require('../utils/thermal');

function otsu(data) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of data) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const bins = 256;
  const hist = new Float64Array(bins);
  const scale = (bins - 1) / Math.max(1, max - min);
  for (const v of data) hist[Math.round((v - min) * scale)] += 1;
  const total = data.length;
  let sum = 0;
  for (let i = 0; i < bins; i += 1) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 0;
  for (let i = 0; i < bins; i += 1) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return min + threshold / scale;
}

/** Componentes conexas (4-vecindad) de una máscara. */
function components(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const comps = [];
  const stack = [];
  for (let i = 0; i < w * h; i += 1) {
    if (!mask[i] || label[i] !== -1) continue;
    const id = comps.length;
    const c = { id, pixels: [], x0: w, x1: 0, y0: h, y1: 0, sx: 0 };
    label[i] = id;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop();
      const x = p % w;
      const y = (p - x) / w;
      c.pixels.push(p);
      c.sx += x;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= w * h) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
        if (mask[q] && label[q] === -1) {
          label[q] = id;
          stack.push(q);
        }
      }
    }
    c.cx = c.sx / c.pixels.length;
    comps.push(c);
  }
  return comps;
}

const mean = (arr) => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);
function pct(arr, p) {
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}

/**
 * Segmenta ambos pies. El pie de la izquierda de la imagen es el DERECHO del
 * paciente (vista plantar desde los pies de la camilla).
 */
function segmentFeet({ width: w, height: h, data }) {
  const thr = otsu(data);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i += 1) mask[i] = data[i] > thr ? 1 : 0;
  const comps = components(mask, w, h)
    .filter((c) => c.pixels.length > 1500)
    .sort((a, b) => b.pixels.length - a.pixels.length)
    .slice(0, 2)
    .sort((a, b) => a.cx - b.cx);
  const background = [];
  for (let i = 0; i < data.length; i += 1) if (!mask[i]) background.push(data[i]);
  return { threshold: thr, feet: comps, background: pct(background, 50), mask };
}

const ROI_BANDS = [
  ['dedo_mayor', 0, 0.2, 'medial'],
  ['dedos_menores', 0, 0.2, 'lateral'],
  ['metatarso', 0.2, 0.42, 'all'],
  ['arco_interno', 0.42, 0.7, 'medial'],
  ['arco_externo', 0.42, 0.7, 'lateral'],
  ['talon', 0.7, 1.01, 'all'],
];

/** Cuentas por ROI para un pie. `medialRight`: el lado medial está a la derecha de la imagen. */
function roiCounts(foot, { width: w, data }, medialRight) {
  const out = {};
  const L = foot.y1 - foot.y0 + 1;
  for (const [roi, a, b, side] of ROI_BANDS) {
    const vals = [];
    for (const p of foot.pixels) {
      const x = p % w;
      const y = (p - x) / w;
      const f = (y - foot.y0) / L;
      if (f < a || f >= b) continue;
      // División medial/lateral por la mediana de x de la banda (aprox. por el centroide).
      const right = x >= foot.cx;
      if (side === 'medial' && right !== medialRight) continue;
      if (side === 'lateral' && right === medialRight) continue;
      vals.push(data[p]);
    }
    out[roi] = vals.length ? { mean: mean(vals), max: pct(vals, 97), min: pct(vals, 3) } : null;
  }
  const all = foot.pixels.map((p) => data[p]);
  out.general = { mean: mean(all), max: pct(all, 97), min: pct(all, 3) };
  return out;
}

/**
 * Conversión aproximada de cuentas crudas a °C: T = a + b·cuentas.
 * Coeficientes obtenidos por regresión lineal entre las cuentas medias por ROI
 * y las temperaturas medidas por el equipo con el software del fabricante
 * (34 termogramas de la toma 1, r = 0,88). NO reemplaza la calibración
 * radiométrica de la cámara: es suficiente para la demostración.
 */
const COUNTS_TO_C = Object.freeze({ a: -32.97, b: 0.012978 });
const toCelsius = (counts) => COUNTS_TO_C.a + COUNTS_TO_C.b * counts;

/**
 * Métricas por ROI (en cuentas) de ambos pies. Convención del equipo de
 * trabajo (validada contra sus mediciones): el pie a la IZQUIERDA de la imagen
 * es el pie IZQUIERDO del paciente; el lado medial de cada pie mira al centro.
 */
function analyzeThermogram(img) {
  const seg = segmentFeet(img);
  if (seg.feet.length < 2) return { ok: false, reason: 'no se detectaron dos pies', seg };
  const [izq, der] = seg.feet;
  const r = { izq: roiCounts(izq, img, true), der: roiCounts(der, img, false) };
  const touches = seg.feet.some((f) => f.y1 >= img.height - 2 || f.y0 <= 1 || f.x0 <= 1 || f.x1 >= img.width - 2);
  const areaRatio = Math.min(der.pixels.length, izq.pixels.length) / Math.max(der.pixels.length, izq.pixels.length);
  return { ok: true, seg, r, touches, areaRatio };
}

/* ---------------- Renderizado ---------------- */

function cubic(p0, p1, p2, p3, t) {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

/** Reescala una matriz con interpolación bicúbica (Catmull-Rom). */
function resizeBicubic(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const at = (x, y) => src[Math.min(sh - 1, Math.max(0, y)) * sw + Math.min(sw - 1, Math.max(0, x))];
  for (let y = 0; y < dh; y += 1) {
    const fy = ((y + 0.5) * sh) / dh - 0.5;
    const iy = Math.floor(fy);
    const ty = fy - iy;
    for (let x = 0; x < dw; x += 1) {
      const fx = ((x + 0.5) * sw) / dw - 0.5;
      const ix = Math.floor(fx);
      const tx = fx - ix;
      const rows = [-1, 0, 1, 2].map((dy) =>
        cubic(at(ix - 1, iy + dy), at(ix, iy + dy), at(ix + 1, iy + dy), at(ix + 2, iy + dy), tx),
      );
      out[y * dw + x] = cubic(rows[0], rows[1], rows[2], rows[3], ty);
    }
  }
  return out;
}

/**
 * Renderiza el termograma a RGB con paleta ironbow, escala [lo, hi] y una
 * barra de color vertical a la derecha (sin texto).
 */
function renderThermogram(img, { lo, hi, width = 960, height = 720, palette = ironbow } = {}) {
  const barW = Math.round(width * 0.022);
  const margin = Math.round(width * 0.02);
  const imgW = width - barW - margin * 2;
  const src = Float32Array.from(img.data);
  const scaled = resizeBicubic(src, img.width, img.height, imgW, height);
  const rgb = Buffer.alloc(width * height * 3);
  const put = (x, y, [r, g, b]) => {
    const i = (y * width + x) * 3;
    rgb[i] = r;
    rgb[i + 1] = g;
    rgb[i + 2] = b;
  };
  const bg = [14, 10, 34];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) put(x, y, bg);
    for (let x = 0; x < imgW; x += 1) put(x, y, palette((scaled[y * imgW + x] - lo) / (hi - lo)));
  }
  const top = Math.round(height * 0.08);
  const bottom = Math.round(height * 0.92);
  const bx = imgW + margin;
  for (let y = top; y < bottom; y += 1) {
    const c = palette(1 - (y - top) / (bottom - top));
    for (let x = bx; x < bx + barW; x += 1) put(x, y, c);
  }
  for (let k = 0; k <= 4; k += 1) {
    const y = Math.round(top + ((bottom - top - 1) * k) / 4);
    for (let x = bx - Math.round(barW * 0.6); x < bx; x += 1) put(x, y, [225, 225, 230]);
  }
  return { width, height, rgb };
}

/**
 * Temperaturas por ROI (°C aproximados) en el formato de AnalysisResult.rois.
 * deltaT = der − izq.
 */
function roisInCelsius(analysis) {
  const keys = ['dedo_mayor', 'dedos_menores', 'metatarso', 'arco_interno', 'arco_externo', 'talon', 'general'];
  const r2 = (v) => Math.round(v * 100) / 100;
  return keys
    .filter((k) => analysis.r.der[k] && analysis.r.izq[k])
    .map((k) => {
      const d = analysis.r.der[k];
      const i = analysis.r.izq[k];
      const avgDer = r2(toCelsius(d.mean));
      const avgIzq = r2(toCelsius(i.mean));
      return {
        roi: k,
        avgDer,
        avgIzq,
        maxDer: r2(toCelsius(d.max)),
        maxIzq: r2(toCelsius(i.max)),
        minDer: r2(toCelsius(d.min)),
        minIzq: r2(toCelsius(i.min)),
        deltaT: r2(avgDer - avgIzq),
      };
    });
}

/** Vista previa PNG de un archivo IS2 (para el navegador). */
function is2PreviewPng(buffer, { width = 640, height = 480 } = {}) {
  const { decodeIs2, percentile } = require('./is2');
  const { encodePng } = require('./png');
  const img = decodeIs2(buffer);
  const lo = percentile(img.data, 2);
  const hi = percentile(img.data, 99.7);
  const out = renderThermogram(img, { lo, hi, width, height });
  return encodePng(out.width, out.height, out.rgb);
}

module.exports = {
  otsu,
  segmentFeet,
  analyzeThermogram,
  renderThermogram,
  resizeBicubic,
  roisInCelsius,
  toCelsius,
  is2PreviewPng,
  COUNTS_TO_C,
  ROI_BANDS,
};
