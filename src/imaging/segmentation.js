'use strict';

/**
 * Segmentación de ambos pies para el análisis punto a punto.
 *
 * Trabaja sobre la matriz de temperatura (°C aproximados) de la cámara:
 *  1. Suavizado 3×3 (sólo para segmentar; las métricas usan los valores
 *     originales).
 *  2. Umbral de Otsu global → «material tibio» (pies, piernas, tela calentada).
 *  3. Semillas: núcleo caliente de cada pie (segundo Otsu dentro del material
 *     tibio), las dos componentes más grandes ordenadas por x. Si un pie está
 *     mucho más frío que el otro, la semilla del lado frío se busca con un
 *     umbral propio de esa mitad de la imagen.
 *  4. Crecimiento de regiones competitivo desde ambas semillas (cola de
 *     prioridad por temperatura, como una inundación «watershed»): un píxel se
 *     agrega si está sobre el umbral global y el descenso de temperatura
 *     respecto del vecino ya incluido es menor que `maxStep` °C. Los dedos fríos
 *     se enfrían de forma gradual y se incluyen; el salto pie → tela/fondo es
 *     brusco y frena el crecimiento. El recorrido desde la semilla se limita
 *     a `maxDist` píxeles para que un fondo tibio no se confunda con el pie.
 *  5. Apertura morfológica, relleno de huecos y componente mayor por pie.
 *
 * Convención del equipo: el pie a la IZQUIERDA de la imagen es el pie
 * IZQUIERDO del paciente (vista plantar).
 */

const NEIGH4 = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

function otsuValues(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!(max > min)) return min;
  const bins = 256;
  const hist = new Float64Array(bins);
  const scale = (bins - 1) / (max - min);
  for (const v of values) hist[Math.round((v - min) * scale)] += 1;
  let total = 0;
  let sum = 0;
  for (let i = 0; i < bins; i += 1) {
    total += hist[i];
    sum += i * hist[i];
  }
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let threshold = 0;
  for (let i = 0; i < bins; i += 1) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return min + (threshold + 0.5) / scale;
}

function smooth3(T, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += T[yy * w + xx];
          n += 1;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

function erode(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      out[i] = mask[i] && mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w] ? 1 : 0;
    }
  }
  return out;
}

function dilate(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      out[i] =
        mask[i] ||
        (x > 0 && mask[i - 1]) ||
        (x < w - 1 && mask[i + 1]) ||
        (y > 0 && mask[i - w]) ||
        (y < h - 1 && mask[i + w])
          ? 1
          : 0;
    }
  }
  return out;
}

/** Componentes conexas (4-vecindad). Devuelve etiquetas y estadísticas. */
function labelComponents(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const comps = [];
  const stack = [];
  for (let i = 0; i < w * h; i += 1) {
    if (!mask[i] || label[i] !== -1) continue;
    const c = { id: comps.length, area: 0, sx: 0, sy: 0, x0: w, x1: 0, y0: h, y1: 0 };
    label[i] = c.id;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop();
      const x = p % w;
      const y = (p - x) / w;
      c.area += 1;
      c.sx += x;
      c.sy += y;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (const [dx, dy] of NEIGH4) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (mask[q] && label[q] === -1) {
          label[q] = c.id;
          stack.push(q);
        }
      }
    }
    c.cx = c.sx / c.area;
    c.cy = c.sy / c.area;
    comps.push(c);
  }
  return { label, comps };
}

/** Conserva sólo la componente más grande y rellena los huecos internos. */
function cleanMask(mask, w, h) {
  const { label, comps } = labelComponents(mask, w, h);
  if (!comps.length) return { mask: new Uint8Array(w * h), area: 0 };
  const big = comps.reduce((a, b) => (b.area > a.area ? b : a));
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i += 1) if (label[i] === big.id) out[i] = 1;
  // Relleno de huecos: el fondo que no toca el borde de la imagen es hueco.
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < inv.length; i += 1) inv[i] = out[i] ? 0 : 1;
  const bg = labelComponents(inv, w, h);
  const outside = new Set(
    bg.comps.filter((c) => c.x0 === 0 || c.y0 === 0 || c.x1 === w - 1 || c.y1 === h - 1).map((c) => c.id),
  );
  let area = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (inv[i] && !outside.has(bg.label[i])) out[i] = 1;
    area += out[i];
  }
  return { mask: out, area };
}

/** Cola de prioridad binaria (máximo primero). */
class MaxHeap {
  constructor() {
    this.keys = [];
    this.vals = [];
  }
  get size() {
    return this.keys.length;
  }
  push(key, val) {
    const k = this.keys;
    const v = this.vals;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] >= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const k = this.keys;
    const v = this.vals;
    const top = v[0];
    const lastK = k.pop();
    const lastV = v.pop();
    if (k.length) {
      k[0] = lastK;
      v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] > k[m]) m = l;
        if (r < k.length && k[r] > k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Semillas: núcleo caliente de cada pie. */
function findSeeds(S, warm, w, h, minArea) {
  const warmVals = [];
  for (let i = 0; i < S.length; i += 1) if (warm[i]) warmVals.push(S[i]);
  if (warmVals.length < minArea * 2) return [];
  const tCore = otsuValues(warmVals);
  const core = new Uint8Array(w * h);
  for (let i = 0; i < S.length; i += 1) core[i] = warm[i] && S[i] > tCore ? 1 : 0;
  const { label, comps } = labelComponents(erode(core, w, h), w, h);
  let big = comps.filter((c) => c.area >= minArea).sort((a, b) => b.area - a.area);
  // Un solo núcleo grande que ocupa ambas mitades: se divide por la columna central.
  if (big.length === 1 && big[0].x0 < w / 2 && big[0].x1 > w / 2 && big[0].x1 - big[0].x0 > w * 0.4) {
    const split = Math.round(big[0].cx);
    const halves = [new Uint8Array(w * h), new Uint8Array(w * h)];
    for (let i = 0; i < label.length; i += 1) {
      if (label[i] !== big[0].id) continue;
      const x = i % w;
      if (Math.abs(x - split) <= 2) continue;
      halves[x < split ? 0 : 1][i] = 1;
    }
    return halves;
  }
  big = big.slice(0, 2);
  if (big.length === 2 && Math.abs(big[0].cx - big[1].cx) > w * 0.12) {
    return big
      .sort((a, b) => a.cx - b.cx)
      .map((c) => {
        const m = new Uint8Array(w * h);
        for (let i = 0; i < label.length; i += 1) if (label[i] === c.id) m[i] = 1;
        return m;
      });
  }
  // Un pie mucho más frío: se busca la semilla en la otra mitad con su propio umbral.
  if (big.length >= 1) {
    const hot = big[0];
    const otherLeft = hot.cx > w / 2;
    const vals = [];
    for (let i = 0; i < S.length; i += 1) {
      const x = i % w;
      if (warm[i] && (otherLeft ? x < w / 2 : x >= w / 2)) vals.push(S[i]);
    }
    if (vals.length >= minArea) {
      const t2 = otsuValues(vals);
      const m2 = new Uint8Array(w * h);
      for (let i = 0; i < S.length; i += 1) {
        const x = i % w;
        m2[i] = warm[i] && S[i] > t2 && (otherLeft ? x < w / 2 : x >= w / 2) ? 1 : 0;
      }
      const lc = labelComponents(erode(m2, w, h), w, h);
      const c2 = lc.comps.filter((c) => c.area >= minArea / 2).sort((a, b) => b.area - a.area)[0];
      if (c2) {
        const a = new Uint8Array(w * h);
        const b = new Uint8Array(w * h);
        for (let i = 0; i < label.length; i += 1) {
          if (label[i] === hot.id) a[i] = 1;
          if (lc.label[i] === c2.id) b[i] = 1;
        }
        return otherLeft ? [b, a] : [a, b];
      }
    }
  }
  return [];
}

/**
 * @param {{width:number,height:number}} dims
 * @param {Float32Array} T  temperatura por píxel (°C)
 * @returns {{ok:boolean, reason?:string, feet?:Array<{mask:Uint8Array, area:number}>, threshold?:number}}
 */
function segmentFeetPointwise(T, { width: w, height: h }, { maxStep = 0.25, maxDist = 40, minArea = 250 } = {}) {
  const S = smooth3(T, w, h);
  // Fondo tibio (p. ej. tela calentada que ocupa casi todo el cuadro): si más
  // del 40 % de la imagen queda sobre el umbral, se repite Otsu sobre esa parte.
  let t0 = otsuValues(S);
  for (let k = 0; k < 2; k += 1) {
    const above = [];
    for (const v of S) if (v > t0) above.push(v);
    if (above.length <= S.length * 0.4) break;
    t0 = otsuValues(above);
  }
  let warm = new Uint8Array(w * h);
  for (let i = 0; i < S.length; i += 1) warm[i] = S[i] > t0 ? 1 : 0;
  warm = dilate(erode(warm, w, h), w, h);

  const seeds = findSeeds(S, warm, w, h, minArea);
  if (seeds.length !== 2) return { ok: false, reason: 'no se detectaron dos pies', threshold: t0 };

  // Crecimiento competitivo (inundación desde lo más caliente).
  const owner = new Int8Array(w * h).fill(-1);
  // Distancia (en píxeles) recorrida desde la semilla: limita fugas hacia el fondo.
  const dist = new Uint16Array(w * h);
  const heap = new MaxHeap();
  seeds.forEach((m, k) => {
    for (let i = 0; i < m.length; i += 1) {
      if (m[i]) {
        owner[i] = k;
        heap.push(S[i], i);
      }
    }
  });
  while (heap.size) {
    const p = heap.pop();
    const x = p % w;
    const y = (p - x) / w;
    for (const [dx, dy] of NEIGH4) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const q = yy * w + xx;
      if (owner[q] !== -1 || !warm[q]) continue;
      if (S[p] - S[q] > maxStep || dist[p] >= maxDist) continue;
      owner[q] = owner[p];
      dist[q] = dist[p] + 1;
      heap.push(S[q], q);
    }
  }

  const feet = [0, 1].map((k) => {
    let m = new Uint8Array(w * h);
    for (let i = 0; i < m.length; i += 1) m[i] = owner[i] === k ? 1 : 0;
    m = dilate(erode(m, w, h), w, h);
    return cleanMask(m, w, h);
  });
  if (feet.some((f) => f.area < minArea)) return { ok: false, reason: 'pie demasiado pequeño', threshold: t0 };
  return { ok: true, feet, threshold: t0 };
}

module.exports = { segmentFeetPointwise, otsuValues, smooth3, labelComponents, cleanMask, erode, dilate };
