'use strict';

/**
 * Calidad automática de cada réplica (foto IS2) de una toma.
 *
 * Mide sobre la matriz IR y las máscaras de los pies (nunca modifica
 * temperaturas) los criterios del relevamiento de calidad de la cohorte:
 *
 *  C1  pie a ≤ 3 px del borde del cuadro (talón, dedos o costado cortado);
 *  C2  pie de menos de 125 px de largo (cámara lejos);
 *  C3  largo / ancho del antepié < 2,2 (dedos o talón perdidos);
 *  C4  largo / ancho > 3,0 (posible pierna o tela en el talón; también un pie largo);
 *  C5  áreas de los pies muy distintas (< 0,85);
 *  C6  pies juntos (≤ 3 px o tocándose);
 *  C7  pies girados (|ángulo| > 25° o diferencia > 20°), leve;
 *  C8  poco contraste pie–fondo (< 4 °C);
 *  C9  fondo tibio (mediana > 25 °C), leve;
 *  C13 IR desenfocada (gradiente en el contorno / contraste < 0,11);
 *  C14 foto visible borrosa (varianza del laplaciano < 8), sin efecto en el análisis.
 *
 * Con esas banderas arma un puntaje para elegir la mejor réplica de cada
 * toma: la calidad de registro de siempre (`qualityScore`) menos una
 * penalización por bandera. Las réplicas a menos de `EMPATE` del mejor
 * puntaje se consideran equivalentes y se prefiere la primera captura.
 *
 * Las banderas son automáticas y no reemplazan la revisión manual de fotos.
 */
const { erode, dilate } = require('./segmentation');

/** Umbrales (los del relevamiento de 606 réplicas, en px de la matriz IR 320 × 240). */
const UMBRALES = Object.freeze({
  margenBorde: 3,
  largoMin: 125,
  largoAnchoMin: 2.2,
  largoAnchoMax: 3.0,
  areaRatioMin: 0.85,
  separacionMin: 3,
  anguloMax: 25,
  anguloDifMax: 20,
  contrasteMin: 4,
  fondoMax: 25,
  nitidezIrMin: 0.11,
  nitidezFotoMin: 8,
  desplazamientoFotoMax: 4,
});

/**
 * Banderas en lenguaje simple. `grave`: afecta el análisis térmico (penaliza
 * la elección de réplica y, si ninguna réplica está libre, marca la toma con
 * calidad baja). `penalizacion`: lo que resta al puntaje de selección.
 */
const BANDERAS = Object.freeze({
  talon_cortado: { label: 'Talón cortado', grave: true, penalizacion: 0.3 },
  dedos_cortados: { label: 'Dedos cortados', grave: true, penalizacion: 0.3 },
  pie_cortado: { label: 'Pie cortado al costado', grave: true, penalizacion: 0.3 },
  pie_incompleto: { label: 'Pie incompleto', grave: true, penalizacion: 0.25 },
  pies_juntos: { label: 'Pies juntos', grave: true, penalizacion: 0.25 },
  fuga_talon: { label: 'Posible tela o pierna en el talón', grave: true, penalizacion: 0.2 },
  tamanos_distintos: { label: 'Pies de distinto tamaño', grave: true, penalizacion: 0.2 },
  camara_lejos: { label: 'Cámara lejos', grave: true, penalizacion: 0.15 },
  poco_contraste: { label: 'Poco contraste', grave: true, penalizacion: 0.15 },
  desenfocada: { label: 'Desenfocada', grave: true, penalizacion: 0.15 },
  foto_borrosa: { label: 'Foto visible borrosa', grave: false, penalizacion: 0.05 },
  foto_desalineada: { label: 'Foto visible desalineada', grave: false, penalizacion: 0 },
  pies_girados: { label: 'Pies girados', grave: false, penalizacion: 0 },
  fondo_tibio: { label: 'Fondo tibio', grave: false, penalizacion: 0 },
});

/** Diferencia de puntaje por debajo de la cual dos réplicas se consideran equivalentes. */
const EMPATE = 0.01;
/** Largo de pie (px) por debajo del cual se resta un poco por cada píxel (cámara más lejos). */
const LARGO_REFERENCIA = 150;

/* ---------------- Utilidades numéricas ---------------- */

/** Percentil con interpolación lineal (como numpy.percentile), p en 0–100. */
function percentile(values, p) {
  const n = values.length;
  if (!n) return NaN;
  const s = Float64Array.from(values).sort();
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(n - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
const median = (values) => percentile(values, 50);

function dilateN(mask, w, h, n) {
  let m = mask;
  for (let k = 0; k < n; k += 1) m = dilate(m, w, h);
  return m;
}

/** Filtro gaussiano separable con borde reflejado (como scipy.ndimage.gaussian_filter). */
function gaussian(src, w, h, sigma) {
  const r = Math.floor(4 * sigma + 0.5);
  const k = [];
  let sum = 0;
  for (let i = -r; i <= r; i += 1) {
    const v = Math.exp((-0.5 * i * i) / (sigma * sigma));
    k.push(v);
    sum += v;
  }
  for (let i = 0; i < k.length; i += 1) k[i] /= sum;
  const refl = (i, n) => {
    // reflect: d c b a | a b c d | d c b a
    let j = i;
    while (j < 0 || j >= n) j = j < 0 ? -j - 1 : 2 * n - j - 1;
    return j;
  };
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let s = 0;
      for (let i = -r; i <= r; i += 1) s += k[i + r] * src[y * w + refl(x + i, w)];
      tmp[y * w + x] = s;
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let s = 0;
      for (let i = -r; i <= r; i += 1) s += k[i + r] * tmp[refl(y + i, h) * w + x];
      out[y * w + x] = s;
    }
  }
  return out;
}

/* ---------------- Geometría de un pie ---------------- */

/** Centroide y eje principal (e1 hacia los dedos = −y), como scripts/ml/common.py#foot_axis. */
function footAxis(mask, w) {
  const xs = [];
  const ys = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    const x = i % w;
    xs.push(x);
    ys.push((i - x) / w);
  }
  const n = xs.length;
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < n; k += 1) {
    cx += xs[k];
    cy += ys[k];
  }
  cx /= n || 1;
  cy /= n || 1;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let k = 0; k < n; k += 1) {
    const dx = xs[k] - cx;
    const dy = ys[k] - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let e1 = [Math.cos(th), Math.sin(th)];
  if (Math.abs(e1[1]) < Math.abs(e1[0])) e1 = [-e1[1], e1[0]];
  if (e1[1] > 0) e1 = [-e1[0], -e1[1]];
  const e2 = [-e1[1], e1[0]];
  const u = new Float64Array(n);
  const v = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    const dx = xs[k] - cx;
    const dy = ys[k] - cy;
    v[k] = dx * e1[0] + dy * e1[1];
    u[k] = dx * e2[0] + dy * e2[1];
  }
  return { xs, ys, cx, cy, e1, e2, u, v };
}

/** Largo (percentiles 0,5–99,5 sobre el eje) y ancho del antepié (10–55 % desde la punta). */
function lengthWidth(ax) {
  const vmax = percentile(ax.v, 99.5);
  const vmin = percentile(ax.v, 0.5);
  const L = vmax - vmin;
  const front = [];
  for (let k = 0; k < ax.v.length; k += 1) {
    const f = (vmax - ax.v[k]) / Math.max(L, 1);
    if (f >= 0.1 && f <= 0.55) front.push(ax.u[k]);
  }
  if (front.length < 20) return { L, vmax, vmin, wid: null, uc: null };
  const u1 = percentile(front, 99);
  const u0 = percentile(front, 1);
  return { L, vmax, vmin, wid: u1 - u0, uc: (u0 + u1) / 2 };
}

/**
 * Medidas de un pie (máscara en coordenadas de la imagen).
 * @returns {null|{area:number, largo:number, ancho:number|null, largoAncho:number|null, angulo:number,
 *   margen:number, ladoMargen:string, bbox:number[]}}
 */
function footStats(mask, w, h) {
  let area = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) area += 1;
  if (area < 250) return null;
  const ax = footAxis(mask, w);
  const lw = lengthWidth(ax);
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let k = 0; k < ax.xs.length; k += 1) {
    const x = ax.xs[k];
    const y = ax.ys[k];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const lados = [
    ['dedos', y0],
    ['talon', h - 1 - y1],
    ['lateral', x0],
    ['lateral', w - 1 - x1],
  ].sort((a, b) => a[1] - b[1]);
  return {
    area,
    largo: lw.L,
    ancho: lw.wid,
    largoAncho: lw.wid ? lw.L / Math.max(lw.wid, 1) : null,
    angulo: (Math.atan2(ax.e1[0], -ax.e1[1]) * 180) / Math.PI,
    margen: lados[0][1],
    ladoMargen: lados[0][0],
    bbox: [x0, y0, x1, y1],
  };
}

/** Distancia euclídea mínima entre dos máscaras (px), con sus contornos. */
function minDistance(a, b, w, h) {
  const edge = (m) => {
    const e = erode(m, w, h);
    const pts = [];
    for (let i = 0; i < m.length; i += 1) if (m[i] && !e[i]) pts.push(i);
    return pts;
  };
  const pa = edge(a);
  const pb = edge(b);
  if (!pa.length || !pb.length) return null;
  let best = Infinity;
  for (const i of pa) {
    const xa = i % w;
    const ya = (i - xa) / w;
    for (const j of pb) {
      const xb = j % w;
      const d = (xa - xb) ** 2 + (ya - (j - xb) / w) ** 2;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/* ---------------- Medidas de una réplica ---------------- */

/**
 * Medidas de calidad de una réplica a partir de la temperatura (°C, sólo se
 * lee) y las máscaras [pie a la izquierda de la imagen, pie a la derecha].
 */
function replicaMetrics({ T, masks, width: w, height: h }) {
  const [a, b] = masks;
  const feet = [footStats(a, w, h), footStats(b, w, h)];
  const ok = feet[0] && feet[1];
  const fg = new Uint8Array(w * h);
  for (let i = 0; i < fg.length; i += 1) fg[i] = a[i] || b[i] ? 1 : 0;
  const da = dilate(a, w, h);
  let puente = false;
  for (let i = 0; i < fg.length && !puente; i += 1) if (da[i] && b[i]) puente = true;
  const near = dilateN(fg, w, h, 4);
  const fgT = [];
  const bgT = [];
  for (let i = 0; i < fg.length; i += 1) {
    if (fg[i]) fgT.push(T[i]);
    else if (!near[i]) bgT.push(T[i]);
  }
  const fgMed = fgT.length ? median(fgT) : null;
  const bgMed = bgT.length ? median(bgT) : null;
  const contraste = fgMed !== null && bgMed !== null ? fgMed - bgMed : null;
  // Nitidez del IR: gradiente en el contorno de los pies relativo al contraste.
  let nitidezIr = null;
  if (fgT.length) {
    const G = gaussian(T, w, h, 0.5);
    const ef = erode(fg, w, h);
    const g = [];
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        if (!fg[i] || ef[i]) continue;
        const gx = x === 0 ? G[i + 1] - G[i] : x === w - 1 ? G[i] - G[i - 1] : (G[i + 1] - G[i - 1]) / 2;
        const gy = y === 0 ? G[i + w] - G[i] : y === h - 1 ? G[i] - G[i - w] : (G[i + w] - G[i - w]) / 2;
        g.push(Math.hypot(gx, gy));
      }
    }
    if (g.length) nitidezIr = median(g) / Math.max(contraste || 1, 0.5);
  }
  const largos = feet.filter(Boolean).map((f) => f.largo);
  const ratios = feet.filter((f) => f && f.largoAncho !== null).map((f) => f.largoAncho);
  return {
    pies: feet,
    largoMin: largos.length ? Math.min(...largos) : null,
    largoAnchoMin: ratios.length ? Math.min(...ratios) : null,
    largoAnchoMax: ratios.length ? Math.max(...ratios) : null,
    areaRatio: ok ? Math.min(feet[0].area, feet[1].area) / Math.max(feet[0].area, feet[1].area) : null,
    margen: feet.filter(Boolean).length ? Math.min(...feet.filter(Boolean).map((f) => f.margen)) : null,
    separacion: ok ? minDistance(a, b, w, h) : null,
    puente,
    anguloMax: ok ? Math.max(Math.abs(feet[0].angulo), Math.abs(feet[1].angulo)) : null,
    // El pie derecho espejado tiene el ángulo con el signo cambiado.
    anguloDif: ok ? Math.abs(feet[0].angulo + feet[1].angulo) : null,
    fondoC: bgMed,
    pieC: fgMed,
    contraste,
    nitidezIr,
  };
}

/**
 * Banderas automáticas de una réplica.
 * @param {object} m resultado de replicaMetrics, más (opcional) `nitidezFoto`
 *   (varianza del laplaciano de la foto visible) y `alineacion`
 *   (src/imaging/visibleAlign.js).
 * @returns {string[]} códigos de BANDERAS
 */
function qualityFlags(m) {
  const U = UMBRALES;
  const out = [];
  const add = (c) => {
    if (!out.includes(c)) out.push(c);
  };
  for (const f of m.pies || []) {
    if (!f || f.margen > U.margenBorde) continue;
    add(f.ladoMargen === 'talon' ? 'talon_cortado' : f.ladoMargen === 'dedos' ? 'dedos_cortados' : 'pie_cortado');
  }
  if (!m.pies || m.pies.some((f) => !f)) add('pie_incompleto');
  if (m.largoMin !== null && m.largoMin < U.largoMin) add('camara_lejos');
  if (m.largoAnchoMin !== null && m.largoAnchoMin < U.largoAnchoMin) add('pie_incompleto');
  if (m.largoAnchoMax !== null && m.largoAnchoMax > U.largoAnchoMax) add('fuga_talon');
  if (m.areaRatio !== null && m.areaRatio < U.areaRatioMin) add('tamanos_distintos');
  if (m.puente || (m.separacion !== null && m.separacion <= U.separacionMin)) add('pies_juntos');
  if (m.contraste !== null && m.contraste < U.contrasteMin) add('poco_contraste');
  if (m.nitidezIr !== null && m.nitidezIr < U.nitidezIrMin) add('desenfocada');
  if (Number.isFinite(m.nitidezFoto) && m.nitidezFoto < U.nitidezFotoMin) add('foto_borrosa');
  const al = m.alineacion;
  if (al && !al.aplicada && Math.max(Math.abs(al.dx), Math.abs(al.dy)) > U.desplazamientoFotoMax)
    add('foto_desalineada');
  if ((m.anguloMax !== null && m.anguloMax > U.anguloMax) || (m.anguloDif !== null && m.anguloDif > U.anguloDifMax))
    add('pies_girados');
  if (m.fondoC !== null && m.fondoC > U.fondoMax) add('fondo_tibio');
  return out;
}

const esGrave = (code) => Boolean(BANDERAS[code]?.grave);

/** Puntaje de selección: calidad de registro − penalizaciones (y un poco por pie chico). */
function selectionScore(calidad, flags, metricas = {}) {
  if (!Number.isFinite(calidad) || calidad < 0) return null;
  let s = calidad;
  for (const c of flags) s -= BANDERAS[c]?.penalizacion || 0;
  const L = metricas.largoMin;
  if (Number.isFinite(L)) s -= Math.min(0.05, 0.002 * Math.max(0, LARGO_REFERENCIA - L));
  return Math.round(s * 1000) / 1000;
}

/**
 * Elige la réplica de una toma: el mayor puntaje; entre las que quedan a menos
 * de `empate` de ese puntaje, la primera captura (menor `rep`).
 * @param {Array<{rep:number, puntaje:number}>} cands
 * @returns {object|null} el candidato elegido
 */
function selectReplica(cands, { empate = EMPATE } = {}) {
  const ok = cands.filter((c) => Number.isFinite(c.puntaje));
  if (!ok.length) return null;
  const best = Math.max(...ok.map((c) => c.puntaje));
  return ok.filter((c) => c.puntaje >= best - empate - 1e-9).sort((a, b) => a.rep - b.rep)[0];
}

/**
 * Resumen de calidad de una toma: banderas de la réplica elegida y si la toma
 * tiene calidad baja (ninguna réplica libre de banderas graves).
 */
function tomaQuality(cands, elegida) {
  const limpias = cands.filter((c) => !(c.banderas || []).some(esGrave)).length;
  const banderas = elegida ? elegida.banderas || [] : [];
  return {
    replicas: cands.length,
    limpias,
    baja: Boolean(elegida) && banderas.some(esGrave),
    banderas,
  };
}

/** Banderas → [{code, label, grave}] para las vistas (ignora códigos desconocidos). */
const flagLabels = (codes) =>
  (codes || [])
    .filter((c) => BANDERAS[c])
    .map((c) => ({ code: c, label: BANDERAS[c].label, grave: BANDERAS[c].grave }));

/**
 * Encuadre de los pies para el visor (px de la matriz IR, con margen) y giro
 * sugerido sólo para mostrar (grados; positivo = horario en pantalla).
 */
function displayHints(m, { w = 320, h = 240, margen = 10 } = {}) {
  const pies = (m.pies || []).filter(Boolean);
  if (!pies.length) return { encuadre: null, giro: 0 };
  const x0 = Math.max(0, Math.min(...pies.map((f) => f.bbox[0])) - margen);
  const y0 = Math.max(0, Math.min(...pies.map((f) => f.bbox[1])) - margen);
  const x1 = Math.min(w, Math.max(...pies.map((f) => f.bbox[2])) + 1 + margen);
  const y1 = Math.min(h, Math.max(...pies.map((f) => f.bbox[3])) + 1 + margen);
  // Con los dos pies, sólo el giro común (los pies abiertos en V no se «enderezan»).
  const media = pies.reduce((s, f) => s + f.angulo, 0) / pies.length;
  const giro = pies.length === 2 && Math.abs(media) >= 3 ? -Math.round(media) : 0;
  return { encuadre: [x0, y0, x1, y1], giro };
}

module.exports = {
  UMBRALES,
  BANDERAS,
  EMPATE,
  percentile,
  gaussian,
  footAxis,
  lengthWidth,
  footStats,
  minDistance,
  replicaMetrics,
  qualityFlags,
  esGrave,
  selectionScore,
  selectReplica,
  tomaQuality,
  flagLabels,
  displayHints,
};
