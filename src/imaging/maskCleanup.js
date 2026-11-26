'use strict';

/**
 * Limpieza de las máscaras de los pies por FORMA (sobre la U-Net o la
 * segmentación clásica). Sólo decide qué píxeles pertenecen a cada pie: las
 * temperaturas nunca se leen ni se modifican acá.
 *
 * Por pie:
 *  1. Puentes finos: apertura de radio 2 y reconstrucción. Una pieza de
 *     ≥ 30 px que cuelga del pie por un cuello de menos de ~5 px (tela, un
 *     borde de la camilla) se descarta, salvo hacia los dedos (dedos fríos
 *     unidos por un cuello fino); el contorno fino del pie se conserva.
 *  2. Prior de forma en el talón (como scripts/ml/common.py#refine_foot): con
 *     el eje principal y el ancho del antepié, se recorta lo que excede
 *     `LARGO_ANCHO_MAX` × ancho desde la punta de los dedos (pierna o tela).
 *     Opcional (`lateral: true`, apagado por defecto): en el último 30 % del
 *     pie, la saliente lateral de más de 0,6 × ancho del eje del antepié, si es
 *     una cuña real (≥ 80 px y ≥ 1,5 % del pie).
 *  3. Relleno de huecos y componente mayor.
 * Entre pies: si se tocan, se quita a cada uno la franja de 1 px pegada al
 * otro (píxeles mezclados), así quedan separados.
 *
 * Salvaguarda: si la limpieza deja un pie con menos del 60 % de su área (o
 * menos de 250 px) se conserva la máscara original de ese pie.
 */
const { erode, dilate, labelComponents } = require('./segmentation');
const { footAxis, lengthWidth } = require('./photoQuality');

/** Largo / ancho del antepié por encima del cual se recorta el talón (típico ≈ 2,6; como
 * scripts/ml/common.py#MAX_LARGO_ANCHO). Con 3,0 se recortaban talones reales de pies largos. */
const LARGO_ANCHO_MAX = 3.4;
const AREA_MIN = 250;
const CONSERVA_MIN = 0.6;
/** Saliente lateral mínima del talón para recortarla (px y fracción del área del pie). */
const LATERAL_MIN = 80;
const LATERAL_FRAC = 0.015;
/** Pieza mínima (px) unida por un cuello fino para descartarla. */
const PIEZA_MIN = 30;

const count = (m) => {
  let n = 0;
  for (let i = 0; i < m.length; i += 1) if (m[i]) n += 1;
  return n;
};

function largest(mask, w, h) {
  const { label, comps } = labelComponents(mask, w, h);
  if (!comps.length) return new Uint8Array(w * h);
  let best = 0;
  for (let k = 1; k < comps.length; k += 1) if (comps[k].area > comps[best].area) best = k;
  const id = comps[best].id ?? best;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i += 1) out[i] = label[i] === id ? 1 : 0;
  return out;
}

/** Relleno de huecos: el fondo no conectado con el borde pasa a ser pie. */
function fillHoles(mask, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = [];
  const push = (i) => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x += 1) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y += 1) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i += 1) out[i] = outside[i] ? 0 : 1;
  return out;
}

const and = (a, b) => a.map((v, i) => (v && b[i] ? 1 : 0));

/** Quita lo que cuelga del pie por un cuello fino (apertura r = 2 + reconstrucción). */
function cutBridges(mask, w, h) {
  let o = erode(erode(mask, w, h), w, h);
  o = dilate(dilate(o, w, h), w, h);
  if (count(o) < AREA_MIN) return mask;
  const core = largest(o, w, h);
  // Reconstrucción acotada: se recupera el contorno fino a ≤ 2 px del núcleo.
  const out = and(mask, dilate(dilate(core, w, h), w, h));
  // Los dedos fríos pueden unirse al pie por un cuello fino: lo que queda
  // separado hacia la punta (último 25 % del largo o más allá) se conserva.
  const rest = mask.map((v, i) => (v && !out[i] ? 1 : 0));
  if (!count(rest)) return out;
  const ax = footAxis(core, w);
  const lw = lengthWidth(ax);
  const { label, comps } = labelComponents(rest, w, h);
  const keep = new Set();
  for (const c of comps) {
    const v = (c.cx - ax.cx) * ax.e1[0] + (c.cy - ax.cy) * ax.e1[1];
    // Se conservan los dedos y los detalles chicos del contorno (< PIEZA_MIN px).
    if (c.area < PIEZA_MIN || v >= lw.vmax - 0.25 * lw.L) keep.add(c.id);
  }
  if (keep.size) for (let i = 0; i < out.length; i += 1) if (rest[i] && keep.has(label[i])) out[i] = 1;
  return out;
}

/** Prior de forma en el talón (dos pasadas, como refine_foot). */
function trimHeel(mask, w, h, info, { lateral = false } = {}) {
  let m = mask;
  for (let pass = 0; pass < 2; pass += 1) {
    if (count(m) < AREA_MIN) break;
    const ax = footAxis(m, w);
    const lw = lengthWidth(ax);
    if (!lw.wid) break;
    const legs = [];
    const lats = [];
    const Lt = Math.min(lw.L, LARGO_ANCHO_MAX * lw.wid);
    const cut = lw.vmax - LARGO_ANCHO_MAX * lw.wid;
    for (let k = 0; k < ax.v.length; k += 1) {
      const i = ax.ys[k] * w + ax.xs[k];
      if (lw.L > LARGO_ANCHO_MAX * lw.wid && ax.v[k] < cut) legs.push(i);
      else if ((lw.vmax - ax.v[k]) / Math.max(Lt, 1) > 0.7 && Math.abs(ax.u[k] - lw.uc) > 0.6 * lw.wid) lats.push(i);
    }
    // La saliente lateral del talón sólo se recorta si se pide (opts.lateral) y
    // es una cuña de verdad: en la cohorte, con la U-Net, casi siempre era el
    // contorno real del talón o un pie mal segmentado de todos modos.
    const cuna = lateral && lats.length >= Math.max(LATERAL_MIN, LATERAL_FRAC * ax.v.length);
    const drop = cuna ? legs.concat(lats) : legs;
    info.talon += legs.length;
    if (cuna) info.lateral += lats.length;
    if (!drop.length) break;
    m = Uint8Array.from(m);
    for (const i of drop) m[i] = 0;
    m = dilate(erode(m, w, h), w, h);
    m = and(m, mask);
    if (count(m) < AREA_MIN) break;
    m = fillHoles(largest(m, w, h), w, h);
  }
  return m;
}

function cleanFoot(mask, w, h, opts = {}) {
  const info = { talon: 0, lateral: 0, puente: 0 };
  const n0 = count(mask);
  if (n0 < AREA_MIN) return { mask, info, conservada: true };
  const b = cutBridges(mask, w, h);
  info.puente = n0 - count(b);
  let m = trimHeel(b, w, h, info, opts);
  m = fillHoles(largest(m, w, h), w, h);
  // Nunca se agregan píxeles que no eran del pie (salvo huecos internos).
  const n = count(m);
  if (n < AREA_MIN || n < CONSERVA_MIN * n0)
    return { mask, info: { talon: 0, lateral: 0, puente: 0 }, conservada: true };
  return { mask: m, info, conservada: false };
}

/**
 * Limpia el par de máscaras [pie a la izquierda de la imagen, pie a la derecha].
 * @returns {{masks: Uint8Array[], info: {cambiados:number, talon:number, lateral:number, puente:number, contacto:number, conservadas:number}}}
 */
function cleanFeetMasks(masks, w, h, opts = {}) {
  const res = masks.map((m) => cleanFoot(m, w, h, opts));
  let [a, b] = res.map((r) => r.mask);
  let contacto = 0;
  const da = dilate(a, w, h);
  const db = dilate(b, w, h);
  let toca = false;
  for (let i = 0; i < a.length && !toca; i += 1) if (a[i] && db[i]) toca = true;
  if (toca) {
    const a2 = a.map((v, i) => (v && !db[i] ? 1 : 0));
    const b2 = b.map((v, i) => (v && !da[i] ? 1 : 0));
    if (count(a2) >= AREA_MIN && count(b2) >= AREA_MIN) {
      contacto = count(a) - count(a2) + count(b) - count(b2);
      a = a2;
      b = b2;
    }
  }
  let cambiados = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (Boolean(a[i]) !== Boolean(masks[0][i])) cambiados += 1;
    if (Boolean(b[i]) !== Boolean(masks[1][i])) cambiados += 1;
  }
  const sum = (k) => res.reduce((s, r) => s + r.info[k], 0);
  return {
    masks: [a, b],
    info: {
      cambiados,
      talon: sum('talon'),
      lateral: sum('lateral'),
      puente: sum('puente'),
      contacto,
      conservadas: res.filter((r) => r.conservada).length,
    },
  };
}

module.exports = { cleanFeetMasks, cleanFoot, fillHoles, cutBridges, LARGO_ANCHO_MAX };
