'use strict';

/**
 * Alineación por réplica de la foto visible con la matriz IR.
 *
 * El registro de la cámara es fijo: el píxel IR (x, y) cae en
 * (80 + 1,5·x, 60 + 1,5·y) de la foto (src/imaging/is2.js#FUSION). En
 * algunas réplicas el contorno de los pies queda corrido unos píxeles. Acá se
 * busca, dentro de ±20 px IR, el desplazamiento que mejor superpone el
 * contorno térmico de los pies (máscara) con la piel de la foto (umbral de
 * Otsu sobre el brillo, con la polaridad que mejor ajuste).
 *
 * El desplazamiento sólo se aplica cuando la separación piel/fondo es clara
 * (Otsu efectivo y buena superposición); si no, se conserva el registro de la
 * cámara. Es sólo para mostrar: nunca cambia la matriz IR ni las temperaturas.
 *
 * También mide la nitidez de la foto (varianza del laplaciano dentro de los pies).
 */
const { FUSION } = require('./is2');
const { erode, dilate } = require('./segmentation');
const { gaussian } = require('./photoQuality');

const BUSQUEDA = 20;
/** Separación piel/fondo mínima (varianza entre clases / varianza total, en la banda de los pies). */
const SEPARACION_MIN = 0.6;
/** Superposición mínima con el mejor desplazamiento. */
const IOU_MIN = 0.8;
/** Mejora mínima de la superposición para mover la foto. */
const MEJORA_MIN = 0.01;

/** Brillo (media RGB) de una imagen RGBA. */
function grayOf({ width, height, data }) {
  const g = new Float32Array(width * height);
  for (let i = 0, o = 0; i < g.length; i += 1, o += 4) g[i] = (data[o] + data[o + 1] + data[o + 2]) / 3;
  return g;
}

/** Campo IR de la foto reducido a la grilla IR (promedio de área 1,5 × 1,5 px). */
function irFieldGray(gray, vw, w = 320, h = 240) {
  const s = FUSION.scale;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const Y0 = FUSION.y + y * s;
    for (let x = 0; x < w; x += 1) {
      const X0 = FUSION.x + x * s;
      // Ventana [X0, X0 + 1,5) × [Y0, Y0 + 1,5): pesos 1 / 0,5 según la fracción cubierta.
      let acc = 0;
      let wt = 0;
      for (let dy = 0; dy < 2; dy += 1) {
        const fy = Math.min(Y0 + s, Math.floor(Y0) + dy + 1) - Math.max(Y0, Math.floor(Y0) + dy);
        if (fy <= 0) continue;
        for (let dx = 0; dx < 2; dx += 1) {
          const fx = Math.min(X0 + s, Math.floor(X0) + dx + 1) - Math.max(X0, Math.floor(X0) + dx);
          if (fx <= 0) continue;
          acc += fx * fy * gray[(Math.floor(Y0) + dy) * vw + Math.floor(X0) + dx];
          wt += fx * fy;
        }
      }
      out[y * w + x] = acc / wt;
    }
  }
  return out;
}

/** Umbral de Otsu (128 clases) y efectividad (varianza entre clases / total) sobre `vals`. */
function otsu(vals) {
  let mn = Infinity;
  let mx = -Infinity;
  for (const v of vals) {
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!(mx > mn)) return { thr: mn, eta: 0 };
  const B = 128;
  const hist = new Float64Array(B);
  const step = (mx - mn) / B;
  for (const v of vals) hist[Math.min(B - 1, Math.floor((v - mn) / step))] += 1;
  const n = vals.length;
  let sumAll = 0;
  let sq = 0;
  for (let k = 0; k < B; k += 1) {
    const c = mn + (k + 0.5) * step;
    sumAll += hist[k] * c;
    sq += hist[k] * c * c;
  }
  const mean = sumAll / n;
  const varT = sq / n - mean * mean;
  let w0 = 0;
  let s0 = 0;
  let best = -1;
  let thr = mn;
  for (let k = 0; k < B - 1; k += 1) {
    const c = mn + (k + 0.5) * step;
    w0 += hist[k];
    s0 += hist[k] * c;
    const w1 = n - w0;
    if (!w0 || !w1) continue;
    const m0 = s0 / w0;
    const m1 = (sumAll - s0) / w1;
    const between = (w0 / n) * (w1 / n) * (m0 - m1) ** 2;
    if (between > best) {
      best = between;
      thr = c;
    }
  }
  return { thr, eta: varT > 0 ? best / varT : 0 };
}

function dilateN(m, w, h, n) {
  let o = m;
  for (let k = 0; k < n; k += 1) o = dilate(o, w, h);
  return o;
}

/**
 * Busca el desplazamiento (px IR) entre la máscara de los pies y la piel de la foto.
 * @param {{width:number,height:number,data:Uint8Array}} visible foto RGBA 640 × 480
 * @param {Uint8Array} fg máscara de los pies (unión, 320 × 240)
 */
function alignVisible(visible, fg, { w = 320, h = 240 } = {}) {
  const gray = grayOf(visible);
  const crop = irFieldGray(gray, visible.width, w, h);
  const band = dilateN(fg, w, h, BUSQUEDA);
  const bandVals = [];
  for (let i = 0; i < band.length; i += 1) if (band[i]) bandVals.push(crop[i]);
  const { thr, eta } = otsu(bandVals);
  let nPts = 0;
  for (let i = 0; i < fg.length; i += 1) if (fg[i]) nPts += 1;
  const px = new Int32Array(nPts);
  const py = new Int32Array(nPts);
  for (let i = 0, k = 0; i < fg.length; i += 1) {
    if (!fg[i]) continue;
    px[k] = i % w;
    py[k] = (i - px[k]) / w;
    k += 1;
  }
  const evaluate = (clara) => {
    // 0 fuera de la banda, 1 banda sin piel, 2 banda con piel.
    const code = new Uint8Array(w * h);
    let skinBand = 0;
    for (let i = 0; i < band.length; i += 1) {
      if (!band[i]) continue;
      const skin = clara ? crop[i] > thr : crop[i] <= thr;
      code[i] = skin ? 2 : 1;
      if (skin) skinBand += 1;
    }
    const iouAt = (dx, dy) => {
      let sIn = 0;
      let inter = 0;
      for (let k = 0; k < nPts; k += 1) {
        const x = px[k] + dx;
        const y = py[k] + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const c = code[y * w + x];
        if (!c) continue;
        sIn += 1;
        if (c === 2) inter += 1;
      }
      const uni = sIn + skinBand - inter;
      return uni ? inter / uni : 0;
    };
    let best = { iou: -1, dx: 0, dy: 0 };
    for (let dy = -BUSQUEDA; dy <= BUSQUEDA; dy += 2) {
      for (let dx = -BUSQUEDA; dx <= BUSQUEDA; dx += 2) {
        const v = iouAt(dx, dy);
        if (v > best.iou) best = { iou: v, dx, dy };
      }
    }
    const c = best;
    for (let dy = c.dy - 1; dy <= c.dy + 1; dy += 1) {
      for (let dx = c.dx - 1; dx <= c.dx + 1; dx += 1) {
        if (Math.abs(dx) > BUSQUEDA || Math.abs(dy) > BUSQUEDA) continue;
        const v = iouAt(dx, dy);
        if (
          v > best.iou + 1e-12 ||
          (Math.abs(v - best.iou) <= 1e-12 && Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy))
        )
          best = { iou: v, dx, dy };
      }
    }
    return { ...best, iou0: iouAt(0, 0) };
  };
  const claro = evaluate(true);
  const oscuro = evaluate(false);
  const r = oscuro.iou > claro.iou ? { ...oscuro, piel: 'oscura' } : { ...claro, piel: 'clara' };
  const enBorde = Math.abs(r.dx) >= BUSQUEDA || Math.abs(r.dy) >= BUSQUEDA;
  const confiable = eta >= SEPARACION_MIN && r.iou >= IOU_MIN && !enBorde;
  const aplicada = confiable && (r.dx !== 0 || r.dy !== 0) && r.iou - r.iou0 >= MEJORA_MIN;
  const round3 = (v) => Math.round(v * 1000) / 1000;
  return {
    dx: r.dx,
    dy: r.dy,
    // En píxeles de la foto (lo que usa el visor).
    dxFoto: aplicada ? r.dx * FUSION.scale : 0,
    dyFoto: aplicada ? r.dy * FUSION.scale : 0,
    iou0: round3(r.iou0),
    iou: round3(r.iou),
    separacion: round3(eta),
    piel: r.piel,
    confiable,
    aplicada,
    gray,
  };
}

/**
 * Coherencia entre réplicas de una toma: el desplazamiento depende sobre todo
 * de la distancia de la cámara, así que uno grande (> `libre` px IR) sólo se
 * aplica si otra réplica confiable de la toma encontró uno parecido (± `tol`).
 * Si no, se vuelve al registro de la cámara. Modifica la lista recibida.
 * @returns {number} cantidad de desplazamientos revocados
 */
function reconcileShifts(list, { libre = 6, tol = 2 } = {}) {
  const conf = list.filter((a) => a && a.confiable);
  let revocados = 0;
  for (const a of list) {
    if (!a || !a.aplicada || Math.max(Math.abs(a.dx), Math.abs(a.dy)) <= libre) continue;
    const respaldo = conf.some((b) => b !== a && Math.abs(b.dx - a.dx) <= tol && Math.abs(b.dy - a.dy) <= tol);
    if (respaldo) continue;
    a.aplicada = false;
    a.dxFoto = 0;
    a.dyFoto = 0;
    a.sinRespaldo = true;
    revocados += 1;
  }
  return revocados;
}

/**
 * Nitidez de la foto visible: varianza del laplaciano (tras un suavizado
 * gaussiano σ = 0,7) dentro de los pies, erosionados 6 px de la foto.
 */
function visibleSharpness(gray, vw, vh, fg, { w = 320, h = 240, dxFoto = 0, dyFoto = 0 } = {}) {
  const G = gaussian(gray, vw, vh, 0.7);
  const s = FUSION.scale;
  const FW = Math.round(w * s);
  const FH = Math.round(h * s);
  let m = new Uint8Array(FW * FH);
  for (let Y = 0; Y < FH; Y += 1) {
    const y = Math.min(h - 1, Math.floor((Y + 0.5) / s));
    for (let X = 0; X < FW; X += 1) m[Y * FW + X] = fg[y * w + Math.min(w - 1, Math.floor((X + 0.5) / s))];
  }
  for (let k = 0; k < 6; k += 1) m = erode(m, FW, FH);
  const refl = (i, n) => (i < 0 ? -i - 1 : i >= n ? 2 * n - i - 1 : i);
  const ox = FUSION.x + Math.round(dxFoto);
  const oy = FUSION.y + Math.round(dyFoto);
  let n = 0;
  let sum = 0;
  let sq = 0;
  for (let Y = 0; Y < FH; Y += 1) {
    for (let X = 0; X < FW; X += 1) {
      if (!m[Y * FW + X]) continue;
      const x = X + ox;
      const y = Y + oy;
      if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
      const c = G[y * vw + x];
      const lap =
        G[y * vw + refl(x - 1, vw)] +
        G[y * vw + refl(x + 1, vw)] +
        G[refl(y - 1, vh) * vw + x] +
        G[refl(y + 1, vh) * vw + x] -
        4 * c;
      n += 1;
      sum += lap;
      sq += lap * lap;
    }
  }
  if (!n) return null;
  const mean = sum / n;
  return sq / n - mean * mean;
}

module.exports = {
  alignVisible,
  reconcileShifts,
  visibleSharpness,
  otsu,
  irFieldGray,
  grayOf,
  BUSQUEDA,
  SEPARACION_MIN,
  IOU_MIN,
};
