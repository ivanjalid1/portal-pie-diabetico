'use strict';

/**
 * Análisis PUNTO A PUNTO (píxel a píxel) de un termograma plantar.
 *
 * Pasos (ver docs/arquitectura.md, «Análisis punto a punto»):
 *  1. Cuentas → °C (ajuste lineal aproximado, `toCelsius`).
 *  2. Segmentación de ambos pies (src/imaging/segmentation.js).
 *  3. Espejado del pie derecho (x → W − 1 − x) para que el lado medial de
 *     ambos pies quede hacia +x.
 *  4. Registro a un marco canónico común por pie: centroide + eje principal
 *     (momentos de segundo orden) + escala anisótropa por la longitud y el
 *     ancho del pie (percentiles 0,5–99,5 % de las proyecciones). Es un
 *     registro afín (rotación, traslación y escala); no deforma el pie.
 *  5. Remuestreo bilineal de cada pie en una grilla canónica de
 *     GRID.w × GRID.h celdas (fila 0 = punta de los dedos, última = talón;
 *     columna 0 = borde lateral, última = borde medial).
 *  6. Mapa ΔT = T(izquierdo) − T(derecho espejado) en las celdas válidas en
 *     ambos pies (se descarta un borde de 1 píxel para evitar el contorno).
 *
 * Las temperaturas NUNCA se modifican ni se completan: las celdas sin dato
 * quedan como NaN y se informan como zonas no analizadas.
 */
const { segmentFeetPointwise, erode } = require('./segmentation');
const { toCelsius } = require('./thermogram');

const GRID = Object.freeze({ w: 40, h: 100 });

/** Zonas anatómicas a lo largo del pie (fracción de la longitud desde la punta). */
const ZONAS = Object.freeze([
  Object.freeze({ key: 'dedos', nombre: 'dedos', desde: 0, hasta: 0.2 }),
  Object.freeze({ key: 'metatarso', nombre: 'metatarso', desde: 0.2, hasta: 0.42 }),
  Object.freeze({ key: 'arco', nombre: 'arco', desde: 0.42, hasta: 0.7 }),
  Object.freeze({ key: 'talon', nombre: 'talón', desde: 0.7, hasta: 1.0001 }),
]);

/** Relación longitud/ancho típica de la planta (se usa si el pie está cortado por el borde). */
const LARGO_ANCHO_TIPICO = 2.6;

function zonaDeFila(r) {
  const f = r / (GRID.h - 1);
  return ZONAS.find((z) => f >= z.desde && f < z.hasta) || ZONAS.at(-1);
}

function celsiusImage(img) {
  const T = new Float32Array(img.data.length);
  for (let i = 0; i < T.length; i += 1) T[i] = toCelsius(img.data[i]);
  return T;
}

function flipX(arr, w, h) {
  const out = new arr.constructor(arr.length);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) out[y * w + x] = arr[y * w + (w - 1 - x)];
  return out;
}

function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

/** Centroide y eje principal (momentos de segundo orden) de una lista de píxeles. */
function axisOf(xs, ys) {
  const n = xs.length;
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < n; k += 1) {
    cx += xs[k];
    cy += ys[k];
  }
  cx /= n;
  cy /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let k = 0; k < n; k += 1) {
    sxx += (xs[k] - cx) ** 2;
    syy += (ys[k] - cy) ** 2;
    sxy += (xs[k] - cx) * (ys[k] - cy);
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let e1 = [Math.cos(theta), Math.sin(theta)];
  // El eje mayor del pie es el más vertical; si el ajuste devolvió el menor, se rota 90°.
  if (Math.abs(e1[1]) < Math.abs(e1[0])) e1 = [-e1[1], e1[0]];
  if (e1[1] > 0) e1 = [-e1[0], -e1[1]]; // hacia los dedos (arriba en la imagen)
  return { cx, cy, e1, e2: [-e1[1], e1[0]] };
}

/**
 * Extensión del pie en su marco: largo por percentiles 0,5–99,5 % y ancho
 * medido sólo en la mitad anterior (dedos–metatarso), donde el pie es más
 * ancho y no hay restos de pierna o tela junto al talón.
 */
function extentOf(xs, ys, ax) {
  const n = xs.length;
  const us = new Float64Array(n);
  const vs = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    vs[k] = (xs[k] - ax.cx) * ax.e1[0] + (ys[k] - ax.cy) * ax.e1[1];
    us[k] = (xs[k] - ax.cx) * ax.e2[0] + (ys[k] - ax.cy) * ax.e2[1];
  }
  const vSorted = Float64Array.from(vs).sort();
  const vmin = quantile(vSorted, 0.005);
  const vmax = quantile(vSorted, 0.995);
  const front = [];
  for (let k = 0; k < n; k += 1) {
    const f = (vmax - vs[k]) / (vmax - vmin);
    if (f >= 0.1 && f <= 0.55) front.push(us[k]);
  }
  front.sort((a, b) => a - b);
  const pad = 0.04 * ((front.at(-1) ?? 0) - (front[0] ?? 0));
  return { vmin, vmax, umin: quantile(front, 0.01) - pad, umax: quantile(front, 0.99) + pad, us, vs };
}

/**
 * Marco del pie (en coordenadas de la imagen ya espejada si corresponde).
 * e1 apunta hacia los dedos (−y aprox.); e2 hacia el lado medial (+x aprox.).
 * Se estima en dos pasadas: la segunda descarta los píxeles fuera del ancho
 * del antepié (p. ej. una cuña de pierna junto al talón) antes de recalcular
 * el eje, para que no lo inclinen.
 */
function footFrame(mask, w, h) {
  const xs = [];
  const ys = [];
  const touches = { top: 0, bottom: 0, left: 0, right: 0 };
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    xs.push(x);
    ys.push(y);
    if (y <= 1) touches.top += 1;
    if (y >= h - 2) touches.bottom += 1;
    if (x <= 1) touches.left += 1;
    if (x >= w - 2) touches.right += 1;
  }
  let ax = axisOf(xs, ys);
  let ext = extentOf(xs, ys, ax);
  const margin = 0.1 * (ext.umax - ext.umin);
  const kx = [];
  const ky = [];
  for (let k = 0; k < xs.length; k += 1) {
    if (ext.us[k] >= ext.umin - margin && ext.us[k] <= ext.umax + margin) {
      kx.push(xs[k]);
      ky.push(ys[k]);
    }
  }
  if (kx.length > xs.length * 0.6) {
    ax = axisOf(kx, ky);
    ext = extentOf(kx, ky, ax);
  }
  return {
    cx: ax.cx,
    cy: ax.cy,
    e1: ax.e1,
    e2: ax.e2,
    area: xs.length,
    angulo: Math.round((Math.atan2(ax.e1[0], -ax.e1[1]) * 180) / Math.PI),
    umin: ext.umin,
    umax: ext.umax,
    vmin: ext.vmin,
    vmax: ext.vmax,
    // Más de 3 píxeles del pie en el borde de la imagen = pie cortado de ese lado.
    cortado: {
      dedos: touches.top > 3,
      talon: touches.bottom > 3,
      lateral: touches.left > 3 || touches.right > 3,
    },
  };
}

function bilinear(T, w, h, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) return NaN;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  return T[i] * (1 - fx) * (1 - fy) + T[i + 1] * fx * (1 - fy) + T[i + w] * (1 - fx) * fy + T[i + w + 1] * fx * fy;
}

/** Remuestrea un pie en la grilla canónica (NaN fuera de la máscara). */
function sampleCanonical(T, mask, w, h, f) {
  const out = new Float32Array(GRID.w * GRID.h).fill(NaN);
  for (let r = 0; r < GRID.h; r += 1) {
    const v = f.vTop - (r / (GRID.h - 1)) * (f.vTop - f.vBottom);
    for (let c = 0; c < GRID.w; c += 1) {
      const u = f.umin + (c / (GRID.w - 1)) * (f.umax - f.umin);
      const x = f.cx + u * f.e2[0] + v * f.e1[0];
      const y = f.cy + u * f.e2[1] + v * f.e1[1];
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h || !mask[yi * w + xi]) continue;
      out[r * GRID.w + c] = bilinear(T, w, h, x, y);
    }
  }
  return out;
}

/**
 * Extremos de la grilla en el eje del pie. Si el pie está cortado por el
 * borde (o es claramente más corto que el otro), se ancla en el extremo
 * íntegro y se usa la longitud esperada: la parte faltante queda sin dato.
 */
function lengthFrames(fi, fd) {
  const len = (f) => f.vmax - f.vmin;
  const ancho = (f) => f.umax - f.umin;
  const esperado = (f) => Math.max(len(f), ancho(f) * LARGO_ANCHO_TIPICO);
  const out = [fi, fd].map((f) => ({ ...f, vTop: f.vmax, vBottom: f.vmin, recortes: [] }));
  out.forEach((f, k) => {
    const otro = out[1 - k];
    const objetivo = Math.max(
      f.cortado.dedos || f.cortado.talon ? esperado(f) : len(f),
      !otro.cortado.dedos && !otro.cortado.talon ? len(otro) : 0,
    );
    if (objetivo <= len(f) * 1.12) return; // diferencia menor al 12 %: se considera completo
    if (f.cortado.talon && !f.cortado.dedos) {
      f.vBottom = f.vmax - objetivo;
      f.recortes.push('talon');
    } else {
      // Dedos fuera del cuadro (o no segmentados por estar fríos): se ancla en el talón.
      f.vTop = f.vmin + objetivo;
      f.recortes.push('dedos');
    }
  });
  return out;
}

/** Procesa una matriz IR completa: segmenta, registra y devuelve las grillas canónicas. */
function canonicalFeet(img, opts = {}) {
  const { width: w, height: h } = img;
  const T = celsiusImage(img);
  // Máscaras externas (p. ej. de la U-Net, scripts/ml/): se usan si son plausibles;
  // si no, se vuelve a la segmentación clásica.
  const externas = plausibleMasks(opts.masks, w, h);
  const seg = externas
    ? { ok: true, feet: externas.map((mask) => ({ mask })), threshold: null }
    : segmentFeetPointwise(T, img, opts);
  if (!seg.ok) return { ok: false, reason: seg.reason };
  const segmentacion = externas ? opts.masksSource || 'externa' : 'clasica';
  // Pie izquierdo del paciente = izquierda de la imagen; el derecho se espeja.
  const maskI = seg.feet[0].mask;
  const maskD = flipX(seg.feet[1].mask, w, h);
  const TD = flipX(T, w, h);
  const [fi, fd] = lengthFrames(footFrame(maskI, w, h), footFrame(maskD, w, h));
  // El borde del pie mezcla piel y fondo: se descarta un píxel de contorno.
  const izq = sampleCanonical(T, erode(maskI, w, h), w, h, fi);
  const der = sampleCanonical(TD, erode(maskD, w, h), w, h, fd);
  const frame = (f) => ({
    angulo: f.angulo,
    largoPx: Math.round(f.vmax - f.vmin),
    anchoPx: Math.round(f.umax - f.umin),
    areaPx: f.area,
    cortado: f.cortado,
    recortes: f.recortes,
  });
  return { ok: true, izq, der, marco: { izq: frame(fi), der: frame(fd) }, umbralFondo: seg.threshold, segmentacion };
}

/** Área mínima (px) de cada pie para aceptar una máscara externa. */
const AREA_MINIMA_EXTERNA = 250;

/**
 * Valida un par de máscaras externas [izquierdo, derecho] (coordenadas de la
 * imagen). Devuelve null si falta alguna o algún pie es demasiado chico.
 */
function plausibleMasks(masks, w, h) {
  if (!Array.isArray(masks) || masks.length !== 2) return null;
  for (const m of masks) {
    if (!m || m.length !== w * h) return null;
    let a = 0;
    for (let i = 0; i < m.length; i += 1) a += m[i] ? 1 : 0;
    if (a < AREA_MINIMA_EXTERNA) return null;
  }
  return masks;
}

/** Etiquetas por píxel (0 fondo, 1 pie izquierdo de la imagen, 2 derecho) → par de máscaras. */
function labelsToMasks(labels) {
  const a = new Uint8Array(labels.length);
  const b = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i] === 1) a[i] = 1;
    else if (labels[i] === 2) b[i] = 1;
  }
  return [a, b];
}

/* ---------------- Métricas sobre las grillas ---------------- */

const valid = (v) => Number.isFinite(v);

/** Suavizado 3×3 dentro de las celdas válidas (para ubicar el máximo sin ruido de un píxel). */
function smoothGrid(g) {
  const out = new Float32Array(g.length).fill(NaN);
  for (let r = 0; r < GRID.h; r += 1) {
    for (let c = 0; c < GRID.w; c += 1) {
      if (!valid(g[r * GRID.w + c])) continue;
      let s = 0;
      let n = 0;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= GRID.h || cc >= GRID.w) continue;
          const v = g[rr * GRID.w + cc];
          if (valid(v)) {
            s += v;
            n += 1;
          }
        }
      }
      out[r * GRID.w + c] = s / n;
    }
  }
  return out;
}

function diffGrid(a, b) {
  const out = new Float32Array(a.length).fill(NaN);
  for (let i = 0; i < a.length; i += 1) if (valid(a[i]) && valid(b[i])) out[i] = a[i] - b[i];
  return out;
}

/**
 * Cobertura por zona: celdas con dato en ambos pies respecto de las celdas
 * del pie más completo. Una zona con menos del 50 % se informa como no analizada.
 */
function zoneCoverage(izq, der) {
  const out = {};
  for (const z of ZONAS) {
    let ambos = 0;
    let ref = 0;
    for (let r = 0; r < GRID.h; r += 1) {
      if (zonaDeFila(r).key !== z.key) continue;
      for (let c = 0; c < GRID.w; c += 1) {
        const i = r * GRID.w + c;
        const a = valid(izq[i]);
        const b = valid(der[i]);
        if (a || b) ref += 1;
        if (a && b) ambos += 1;
      }
    }
    out[z.key] = ref ? ambos / ref : 0;
  }
  return out;
}

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/**
 * Métricas de asimetría punto a punto de una toma.
 * @param {Float32Array} izq  grilla canónica del pie izquierdo
 * @param {Float32Array} der  grilla canónica del pie derecho (espejado)
 * @param {{umbralPixel:number}} p
 */
function asymmetryMetrics(izq, der, { umbralPixel = 1, zonasExcluidas = [] } = {}) {
  const dt = diffGrid(izq, der);
  // Las zonas no analizadas se excluyen por completo de las métricas.
  for (let r = 0; r < GRID.h; r += 1) {
    if (!zonasExcluidas.includes(zonaDeFila(r).key)) continue;
    for (let c = 0; c < GRID.w; c += 1) dt[r * GRID.w + c] = NaN;
  }
  const abs = [];
  let sum = 0;
  let hot = 0;
  for (const v of dt) {
    if (!valid(v)) continue;
    abs.push(Math.abs(v));
    sum += v;
    if (Math.abs(v) > umbralPixel) hot += 1;
  }
  if (!abs.length) return null;
  abs.sort((a, b) => a - b);
  const sm = smoothGrid(dt);
  let best = -1;
  let bi = -1;
  for (let i = 0; i < sm.length; i += 1) {
    if (valid(sm[i]) && Math.abs(sm[i]) > best) {
      best = Math.abs(sm[i]);
      bi = i;
    }
  }
  const row = Math.floor(bi / GRID.w);
  const col = bi % GRID.w;
  return {
    celdas: abs.length,
    areaCalientePct: Math.round((hot / abs.length) * 1000) / 10,
    mediaAbs: r2(abs.reduce((s, v) => s + v, 0) / abs.length),
    p95Abs: r2(quantile(abs, 0.95)),
    maxAbs: r2(best),
    mediaConSigno: r2(sum / abs.length),
    hotspot: {
      fila: row,
      col,
      deltaT: r2(sm[bi]),
      zona: zonaDeFila(row).key,
      lado: col >= GRID.w / 2 ? 'medial' : 'lateral',
      pieMasCaliente: sm[bi] >= 0 ? 'izquierdo' : 'derecho',
    },
  };
}

/** Cambio entre tomas de un pie (T2 − T1) ya registrado en la grilla canónica. */
function changeMetrics(t1, t2, { umbralCambio = 1 } = {}) {
  const d = diffGrid(t2, t1);
  const vals = [...d].filter(valid).sort((a, b) => a - b);
  if (!vals.length) return null;
  const mediana = quantile(vals, 0.5);
  let local = 0;
  for (const v of vals) if (Math.abs(v - mediana) > umbralCambio) local += 1;
  const abs = vals.map((v) => Math.abs(v)).sort((a, b) => a - b);
  return {
    celdas: vals.length,
    mediana: r2(mediana),
    media: r2(vals.reduce((s, v) => s + v, 0) / vals.length),
    p95Abs: r2(quantile(abs, 0.95)),
    areaCambioLocalPct: Math.round((local / vals.length) * 1000) / 10,
  };
}

/* ---------------- ROIs (referencia de la Parte 1) desde la grilla ---------------- */

const ROI_DEF = [
  ['dedo_mayor', 0, 0.2, 'medial'],
  ['dedos_menores', 0, 0.2, 'lateral'],
  ['metatarso', 0.2, 0.42, 'all'],
  ['arco_interno', 0.42, 0.7, 'medial'],
  ['arco_externo', 0.42, 0.7, 'lateral'],
  ['talon', 0.7, 1.01, 'all'],
  ['general', 0, 1.01, 'all'],
];

function roiStats(g, a, b, side) {
  const vals = [];
  for (let r = 0; r < GRID.h; r += 1) {
    const f = r / (GRID.h - 1);
    if (f < a || f >= b) continue;
    for (let c = 0; c < GRID.w; c += 1) {
      const medial = c >= GRID.w / 2;
      if (side === 'medial' && !medial) continue;
      if (side === 'lateral' && medial) continue;
      const v = g[r * GRID.w + c];
      if (valid(v)) vals.push(v);
    }
  }
  if (vals.length < 5) return null;
  vals.sort((x, y) => x - y);
  return { mean: vals.reduce((s, v) => s + v, 0) / vals.length, max: quantile(vals, 0.97), min: quantile(vals, 0.03) };
}

/** ROIs por región en el formato de AnalysisResult.rois (ΔT = der − izq, convención de la Parte 1). */
function roisFromGrids(izq, der) {
  const out = [];
  for (const [roi, a, b, side] of ROI_DEF) {
    const i = roiStats(izq, a, b, side);
    const d = roiStats(der, a, b, side);
    if (!i || !d) continue;
    const avgDer = r2(d.mean);
    const avgIzq = r2(i.mean);
    out.push({
      roi,
      avgDer,
      avgIzq,
      maxDer: r2(d.max),
      maxIzq: r2(i.max),
      minDer: r2(d.min),
      minIzq: r2(i.min),
      deltaT: r2(avgDer - avgIzq),
    });
  }
  return out;
}

/* ---------------- Serialización compacta de grillas ---------------- */

const NODATA = -32768;

/** Grilla → base64 de Int16 en centésimas de °C (NaN → −32768). */
function encodeGrid(g) {
  const buf = Buffer.alloc(g.length * 2);
  for (let i = 0; i < g.length; i += 1) {
    buf.writeInt16LE(valid(g[i]) ? Math.max(-32767, Math.min(32767, Math.round(g[i] * 100))) : NODATA, i * 2);
  }
  return buf.toString('base64');
}

function decodeGrid(s) {
  const buf = Buffer.from(s, 'base64');
  const out = new Float32Array(buf.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const v = buf.readInt16LE(i * 2);
    out[i] = v === NODATA ? NaN : v / 100;
  }
  return out;
}

/** Calidad de una captura (para elegir entre réplicas): solapamiento y simetría de las máscaras. */
function qualityScore(cf) {
  if (!cf.ok) return -1;
  let a = 0;
  let b = 0;
  let both = 0;
  for (let i = 0; i < cf.izq.length; i += 1) {
    const x = valid(cf.izq[i]);
    const y = valid(cf.der[i]);
    if (x) a += 1;
    if (y) b += 1;
    if (x && y) both += 1;
  }
  const iou = both / Math.max(1, a + b - both);
  const areas = Math.min(cf.marco.izq.areaPx, cf.marco.der.areaPx) / Math.max(cf.marco.izq.areaPx, cf.marco.der.areaPx);
  const cortes = ['izq', 'der'].reduce(
    (s, k) => s + Object.values(cf.marco[k].cortado).filter(Boolean).length + cf.marco[k].recortes.length,
    0,
  );
  return Math.round((iou * 0.7 + areas * 0.3 - cortes * 0.1) * 1000) / 1000;
}

module.exports = {
  GRID,
  ZONAS,
  LARGO_ANCHO_TIPICO,
  zonaDeFila,
  canonicalFeet,
  asymmetryMetrics,
  changeMetrics,
  zoneCoverage,
  roisFromGrids,
  diffGrid,
  smoothGrid,
  encodeGrid,
  decodeGrid,
  qualityScore,
  footFrame,
  celsiusImage,
  labelsToMasks,
  plausibleMasks,
};

/**
 * Procesa un archivo .IS2 completo y devuelve las grillas serializadas
 * (listas para guardar en el análisis) junto con la calidad y el marco.
 */
function analyzeIs2Pointwise(buffer, opts = {}) {
  const { decodeIs2 } = require('./is2');
  const cf = canonicalFeet(decodeIs2(buffer), opts);
  if (!cf.ok) return { ok: false, reason: cf.reason };
  return {
    ok: true,
    segmentacion: cf.segmentacion,
    calidad: qualityScore(cf),
    marco: cf.marco,
    izq: encodeGrid(cf.izq),
    der: encodeGrid(cf.der),
  };
}

/** Fecha de captura guardada por la cámara en el ZIP (fecha DOS de la primera entrada). */
function is2CaptureDate(buffer) {
  try {
    let i = buffer.length - 22;
    while (i >= 0 && buffer.readUInt32LE(i) !== 0x06054b50) i -= 1;
    if (i < 0) return null;
    const p = buffer.readUInt32LE(i + 16);
    const t = buffer.readUInt16LE(p + 12);
    const d = buffer.readUInt16LE(p + 14);
    const date = new Date((d >> 9) + 1980, ((d >> 5) & 15) - 1, d & 31, t >> 11, (t >> 5) & 63);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

module.exports.analyzeIs2Pointwise = analyzeIs2Pointwise;
module.exports.is2CaptureDate = is2CaptureDate;
