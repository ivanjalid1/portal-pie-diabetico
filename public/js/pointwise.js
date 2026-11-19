/* Mapas punto a punto (canvas) a partir de las grillas canónicas del análisis.
 * Los datos llegan en <script type="application/json" data-pw-data id="..."> (no se ejecutan).
 * Lienzos:
 *   <canvas data-pw-map="1:izq|1:der|1:dt|cambio:izq|cambio:der|tci-1:izq|tci-1:der|fc:actual|fc:esperado" data-pw-src="id">
 *   <canvas data-pw-hist="1" data-pw-src="id">
 * Nunca se modifican las temperaturas: las celdas sin dato se pintan en gris
 * o se dejan transparentes. */
(function () {
  'use strict';

  const NODATA = -32768;
  const ZONAS = [0.2, 0.42, 0.7];
  const ZONA_NOMBRES = ['Dedos', 'Metatarso', 'Arco', 'Talón'];
  const ZONA_KEYS = ['dedos', 'metatarso', 'arco', 'talon'];

  function decode(b64) {
    const bin = atob(b64);
    const out = new Float32Array(bin.length / 2);
    for (let i = 0; i < out.length; i += 1) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v & 0x8000) v -= 0x10000;
      out[i] = v === NODATA ? NaN : v / 100;
    }
    return out;
  }

  const ok = Number.isFinite;

  function css(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  /* Escala divergente azul (negativo) → blanco → rojo (positivo). */
  const NEG = [37, 99, 166];
  const POS = [208, 52, 44];
  const MID = [247, 247, 247];
  function diverging(v, max) {
    const t = Math.max(-1, Math.min(1, v / max));
    const c = t >= 0 ? POS : NEG;
    const k = Math.abs(t) ** 0.85;
    return [0, 1, 2].map((j) => Math.round(MID[j] + (c[j] - MID[j]) * k));
  }

  /* Color de la paleta con interpolación lineal entre entradas (sin bandas). */
  function lutColor(lut, t) {
    const x = Math.max(0, Math.min(1, t)) * (lut.length - 1);
    const i = Math.min(lut.length - 2, Math.floor(x));
    const f = x - i;
    const a = lut[i];
    const b = lut[i + 1];
    return [0, 1, 2].map((j) => Math.round(a[j] + (b[j] - a[j]) * f));
  }

  function zoneRowExcluded(r, h, excluded) {
    if (!excluded || !excluded.length) return false;
    const f = r / (h - 1);
    const z = f < 0.2 ? 'dedos' : f < 0.42 ? 'metatarso' : f < 0.7 ? 'arco' : 'talon';
    return excluded.includes(z);
  }

  /* Datos derivados de una fuente (se calculan una vez). */
  const cache = new Map();
  function source(id) {
    if (cache.has(id)) return cache.get(id);
    const el = document.getElementById(id);
    if (!el) return null;
    const d = JSON.parse(el.textContent);
    const W = d.grilla.w;
    const H = d.grilla.h;
    const tomas = {};
    const all = [];
    for (const t of d.tomas) {
      const izq = decode(t.izq);
      const der = decode(t.der);
      const dt = new Float32Array(izq.length).fill(NaN);
      for (let i = 0; i < izq.length; i += 1) {
        const r = Math.floor(i / W);
        if (ok(izq[i]) && ok(der[i]) && !zoneRowExcluded(r, H, t.zonasNoAnalizadas)) dt[i] = izq[i] - der[i];
        if (ok(izq[i])) all.push(izq[i]);
        if (ok(der[i])) all.push(der[i]);
      }
      const tci = t.tci && t.tci.mapas ? { izq: decode(t.tci.mapas.izq), der: decode(t.tci.mapas.der) } : null;
      tomas[t.toma] = { ...t, izqG: izq, derG: der, dt, tciG: tci };
    }
    all.sort((a, b) => a - b);
    const lo = d.rango ? d.rango.lo : all[Math.floor(all.length * 0.02)];
    const hi = d.rango ? d.rango.hi : all[Math.floor(all.length * 0.98)];
    let cambio = null;
    if (tomas[1] && tomas[2]) {
      cambio = {};
      for (const k of ['izq', 'der']) {
        const a = tomas[1][`${k}G`];
        const b = tomas[2][`${k}G`];
        const g = new Float32Array(a.length).fill(NaN);
        for (let i = 0; i < a.length; i += 1) if (ok(a[i]) && ok(b[i])) g[i] = b[i] - a[i];
        // Sólo para la escala de color: se centra en el cambio mediano del pie
        // (ambiente / día) para que se vean los cambios locales. Los valores no se alteran.
        const vals = Array.from(g)
          .filter(ok)
          .sort((x, y) => x - y);
        const med = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
        cambio[k] = g;
        cambio[`${k}Mediana`] = med;
      }
    }
    const s = { d, W, H, tomas, lo, hi, cambio };
    cache.set(id, s);
    return s;
  }

  /* ---------- Dibujo de mapas ----------
   * Cada lienzo tiene un margen izquierdo (zonas) y el pie a la derecha.
   * La grilla se interpola en forma bilineal sólo entre puntos medidos (sin
   * extrapolar): el borde del pie sale de la máscara interpolada, y las métricas
   * siguen usando la grilla original. */
  const FOOT_MAX = 150;

  const LABEL_FONT = (compact) => `500 ${compact ? 9 : 10}px Geist, system-ui, sans-serif`;
  const zoneNames = (compact) => (compact ? ['Dedos', 'Metat.', 'Arco', 'Talón'] : ZONA_NOMBRES);

  function layout(canvas, W, H) {
    const cssW = canvas.clientWidth || 180;
    const compact = cssW < 170;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Margen para los nombres de zona (medido con la fuente real).
    ctx.font = LABEL_FONT(compact);
    const labelW = Math.max(...zoneNames(compact).map((n) => ctx.measureText(n).width));
    const need = Math.ceil(labelW) + 14;
    const footW = Math.max(40, Math.min(FOOT_MAX, cssW - need - 4));
    const footH = Math.round((footW * H) / W);
    const pad = 6;
    const cssH = footH + pad * 2;
    canvas.style.height = `${cssH}px`;
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    // Pie centrado en el lienzo si entra; si no, a la derecha del margen.
    const centered = (cssW - footW) / 2;
    const x0 = Math.round(centered >= need ? centered : need + (cssW - need - footW) / 2);
    return { ctx, dpr, cssW, cssH, x0, y0: pad, footW, footH, compact };
  }

  /* Muestreo bilineal ponderado sólo por vecinos con dato: devuelve [valor, cobertura 0..1]. */
  function sampler(grid, W, H, flip) {
    return (gx, gy) => {
      const fx = gx - 0.5;
      const fy = gy - 0.5;
      const xa = Math.floor(fx);
      const ya = Math.floor(fy);
      const tx = fx - xa;
      const ty = fy - ya;
      let acc = 0;
      let wsum = 0;
      for (let j = 0; j < 2; j += 1) {
        const yy = ya + j;
        if (yy < 0 || yy >= H) continue;
        const wy = j ? ty : 1 - ty;
        for (let i = 0; i < 2; i += 1) {
          let xx = xa + i;
          if (xx < 0 || xx >= W) continue;
          const wx = i ? tx : 1 - tx;
          if (flip) xx = W - 1 - xx;
          const v = grid[yy * W + xx];
          if (!ok(v)) continue;
          acc += v * wx * wy;
          wsum += wx * wy;
        }
      }
      return wsum > 0 ? [acc / wsum, wsum] : [NaN, 0];
    };
  }

  const edge = (m) => Math.max(0, Math.min(1, (m - 0.38) / 0.24));

  /* Imagen suave del pie (resolución del lienzo) con borde antialiasado. */
  function footImage(L, W, H, grid, colorOf, flip) {
    const pw = Math.round(L.footW * L.dpr);
    const ph = Math.round(L.footH * L.dpr);
    const off = document.createElement('canvas');
    off.width = pw;
    off.height = ph;
    const octx = off.getContext('2d');
    const img = octx.createImageData(pw, ph);
    const s = sampler(grid, W, H, flip);
    for (let y = 0; y < ph; y += 1) {
      const gy = ((y + 0.5) / ph) * H;
      for (let x = 0; x < pw; x += 1) {
        const [v, m] = s(((x + 0.5) / pw) * W, gy);
        const a = edge(m);
        if (!a) continue;
        const col = colorOf(v);
        const o = (y * pw + x) * 4;
        img.data[o] = col[0];
        img.data[o + 1] = col[1];
        img.data[o + 2] = col[2];
        img.data[o + 3] = Math.round(a * 255);
      }
    }
    octx.putImageData(img, 0, 0);
    return off;
  }

  let hatchTile = null;
  function hatchPattern(ctx) {
    if (!hatchTile) {
      hatchTile = document.createElement('canvas');
      hatchTile.width = 7;
      hatchTile.height = 7;
      const t = hatchTile.getContext('2d');
      t.strokeStyle = 'rgba(96, 114, 133, 0.42)';
      t.lineWidth = 1;
      t.beginPath();
      t.moveTo(-1, 8);
      t.lineTo(8, -1);
      t.moveTo(-1, 1);
      t.lineTo(1, -1);
      t.moveTo(6, 8);
      t.lineTo(8, 6);
      t.stroke();
    }
    return ctx.createPattern(hatchTile, 'repeat');
  }

  /* Silueta (unión de ambos pies) con sombra suave; con trama diagonal donde no hay par. */
  function silhouette(L, W, H, maskGrid, flip, hatch) {
    const sil = footImage(L, W, H, maskGrid, () => [238, 242, 247], flip);
    const { ctx } = L;
    ctx.save();
    ctx.shadowColor = 'rgba(15, 30, 44, 0.2)';
    ctx.shadowBlur = 7;
    ctx.shadowOffsetY = 1.5;
    ctx.drawImage(sil, L.x0, L.y0, L.footW, L.footH);
    ctx.restore();
    if (!hatch) return;
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = hatchPattern(ctx);
    ctx.fillRect(L.x0, L.y0, L.footW, L.footH);
    ctx.restore();
  }

  /* Zonas: marcas y nombres en el margen; líneas muy tenues sólo dentro del pie. */
  function zones(L, { labels }) {
    const { ctx, x0, y0, footW, footH } = L;
    const ys = ZONAS.map((f) => Math.round(y0 + f * footH) + 0.5);
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.strokeStyle = 'rgba(15, 30, 44, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const y of ys) {
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + footW, y);
    }
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = css('--line-strong', '#cbd5e0');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const y of ys) {
      ctx.moveTo(x0 - 10, y);
      ctx.lineTo(x0 - 3, y);
    }
    ctx.stroke();
    if (labels) {
      ctx.fillStyle = css('--muted', '#607285');
      ctx.font = LABEL_FONT(L.compact);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const bounds = [0, ...ZONAS, 1];
      const names = zoneNames(L.compact);
      for (let k = 0; k < 4; k += 1) {
        const yc = y0 + ((bounds[k] + bounds[k + 1]) / 2) * footH;
        ctx.fillText(names[k], x0 - 7, yc);
      }
    }
    ctx.restore();
  }

  /* Suavizado leve (3 × 3 binomial) de |ΔT| sobre celdas con dato; sin dato → 0 (cierra contornos). */
  function smoothAbs(grid, W, H) {
    const out = new Float32Array(W * H);
    const k = [1, 2, 1];
    for (let r = 0; r < H; r += 1) {
      for (let c = 0; c < W; c += 1) {
        if (!ok(grid[r * W + c])) continue;
        let acc = 0;
        let ws = 0;
        for (let j = -1; j <= 1; j += 1) {
          for (let i = -1; i <= 1; i += 1) {
            const rr = r + j;
            const cc = c + i;
            if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
            const v = grid[rr * W + cc];
            if (!ok(v)) continue;
            const w = k[j + 1] * k[i + 1];
            acc += Math.abs(v) * w;
            ws += w;
          }
        }
        out[r * W + c] = acc / ws;
      }
    }
    return out;
  }

  /* Contorno |ΔT| = umbral: marching squares con interpolación lineal sobre la grilla
   * remuestreada ×3 (bilineal). Devuelve segmentos en coordenadas de celda. */
  function contourSegments(field, W, H, thr, F = 3) {
    const GW = W * F;
    const GH = H * F;
    const s = sampler(field, W, H, false);
    const f = new Float32Array((GW + 1) * (GH + 1));
    for (let y = 0; y <= GH; y += 1) {
      for (let x = 0; x <= GW; x += 1) {
        const [v] = s((x / GW) * W, (y / GH) * H);
        f[y * (GW + 1) + x] = (ok(v) ? v : 0) - thr;
      }
    }
    const at = (x, y) => f[y * (GW + 1) + x];
    const t = (a, b) => a / (a - b);
    const segs = [];
    for (let y = 0; y < GH; y += 1) {
      for (let x = 0; x < GW; x += 1) {
        const a = at(x, y);
        const b = at(x + 1, y);
        const c = at(x + 1, y + 1);
        const d = at(x, y + 1);
        const idx = (a > 0 ? 8 : 0) | (b > 0 ? 4 : 0) | (c > 0 ? 2 : 0) | (d > 0 ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const T = [x + t(a, b), y];
        const R = [x + 1, y + t(b, c)];
        const B = [x + t(d, c), y + 1];
        const Lf = [x, y + t(a, d)];
        const add = (p, q) => segs.push([p[0] / F, p[1] / F, q[0] / F, q[1] / F]);
        if (idx === 1 || idx === 14) add(Lf, B);
        else if (idx === 2 || idx === 13) add(B, R);
        else if (idx === 3 || idx === 12) add(Lf, R);
        else if (idx === 4 || idx === 11) add(T, R);
        else if (idx === 6 || idx === 9) add(T, B);
        else if (idx === 7 || idx === 8) add(Lf, T);
        else if (idx === 5) {
          add(Lf, T);
          add(B, R);
        } else if (idx === 10) {
          add(T, R);
          add(Lf, B);
        }
      }
    }
    return segs;
  }

  function drawContour(L, W, H, dt, thr) {
    const segs = contourSegments(smoothAbs(dt, W, H), W, H, thr);
    if (!segs.length) return;
    const { ctx, x0, y0, footW, footH } = L;
    const sx = footW / W;
    const sy = footH / H;
    const path = new Path2D();
    for (const [ax, ay, bx, by] of segs) {
      path.moveTo(x0 + ax * sx, y0 + ay * sy);
      path.lineTo(x0 + bx * sx, y0 + by * sy);
    }
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 3;
    ctx.stroke(path);
    ctx.strokeStyle = 'rgba(15, 30, 44, 0.85)';
    ctx.lineWidth = 1.2;
    ctx.stroke(path);
    ctx.restore();
  }

  /* Punto de mayor diferencia: anillo con halo blanco y punto central. */
  function hotspotMark(L, W, H, hs) {
    if (!hs) return;
    const { ctx } = L;
    const x = L.x0 + ((hs.col + 0.5) * L.footW) / W;
    const y = L.y0 + ((hs.fila + 0.5) * L.footH) / H;
    const ink = css('--text', '#0f1e2c');
    const r = Math.max(4.5, Math.min(7, L.footW / 16));
    ctx.save();
    ctx.shadowColor = 'rgba(15, 30, 44, 0.35)';
    ctx.shadowBlur = 5;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = ink;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.32, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function unionMask(a, b) {
    const m = new Float32Array(a.length).fill(NaN);
    for (let i = 0; i < a.length; i += 1) if (ok(a[i]) || (b && ok(b[i]))) m[i] = 1;
    return m;
  }

  function drawMap(canvas) {
    const s = source(canvas.dataset.pwSrc);
    if (!s) return;
    const [which, foot] = canvas.dataset.pwMap.split(':');
    const L = layout(canvas, s.W, s.H);
    const put = (img) => L.ctx.drawImage(img, L.x0, L.y0, L.footW, L.footH);
    if (which === 'cambio') {
      if (!s.cambio) return;
      const flip = foot === 'der';
      const med = s.cambio[`${foot}Mediana`] || 0;
      silhouette(L, s.W, s.H, unionMask(s.tomas[1][`${foot}G`], s.tomas[2][`${foot}G`]), flip, true);
      put(footImage(L, s.W, s.H, s.cambio[foot], (v) => diverging(v - med, 3), flip));
      zones(L, { labels: true });
      return;
    }
    if (which.startsWith('tci-')) {
      // Desvío respecto del patrón de referencia del TCI (°C, sin modificar).
      const tt = s.tomas[which.slice(4)];
      if (!tt || !tt.tciG) return;
      const g = tt.tciG[foot];
      const flip = foot === 'der';
      silhouette(L, s.W, s.H, unionMask(foot === 'izq' ? tt.izqG : tt.derG), flip, true);
      put(footImage(L, s.W, s.H, g, (v) => diverging(v, 4), flip));
      zones(L, { labels: true });
      return;
    }
    if (which === 'fc') {
      // Pronóstico: ΔT esperado = β · ΔT de la última toma (encogimiento). La toma actual se dibuja igual.
      const fc = s.d.pronostico;
      const tt = fc && s.tomas[fc.toma];
      if (!tt) return;
      const g = foot === 'esperado' ? tt.dt.map((v) => (ok(v) ? v * fc.beta : NaN)) : tt.dt;
      silhouette(L, s.W, s.H, unionMask(tt.izqG, tt.derG), false, true);
      put(footImage(L, s.W, s.H, g, (v) => diverging(v, 3), false));
      zones(L, { labels: true });
      drawContour(L, s.W, s.H, g, s.d.umbralPixel);
      return;
    }
    const t = s.tomas[which];
    if (!t) return;
    if (foot === 'dt') {
      silhouette(L, s.W, s.H, unionMask(t.izqG, t.derG), false, true);
      put(footImage(L, s.W, s.H, t.dt, (v) => diverging(v, 3), false));
      zones(L, { labels: true });
      drawContour(L, s.W, s.H, t.dt, s.d.umbralPixel);
      hotspotMark(L, s.W, s.H, t.metricas && t.metricas.hotspot);
      return;
    }
    const g = foot === 'izq' ? t.izqG : t.derG;
    const flip = foot === 'der';
    silhouette(L, s.W, s.H, unionMask(g), flip, false);
    put(footImage(L, s.W, s.H, g, (v) => lutColor(s.d.lut, (v - s.lo) / (s.hi - s.lo)), flip));
    zones(L, { labels: true });
  }

  function drawHist(canvas) {
    const s = source(canvas.dataset.pwSrc);
    if (!s) return;
    const t = s.tomas[canvas.dataset.pwHist];
    if (!t) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 280;
    const h = Number(canvas.dataset.height || 130);
    canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const step = 0.2;
    const maxV = 4;
    const nb = Math.round(maxV / step);
    const bins = new Array(nb).fill(0);
    let n = 0;
    for (const v of t.dt) {
      if (!ok(v)) continue;
      n += 1;
      bins[Math.min(nb - 1, Math.floor(Math.abs(v) / step))] += 1;
    }
    if (!n) return;
    const pad = { l: 34, r: 8, t: 10, b: 24 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const top = Math.max(...bins) / n;
    const yMax = Math.ceil((top * 100) / 10) * 10 || 10;
    const thr = s.d.umbralPixel;
    const muted = css('--muted', '#607285');
    const line = css('--line', '#e2e8ef');
    const heat = css('--danger', '#d0342c');
    const base = css('--brand-200', '#a6e3ea');
    ctx.font = '11px Geist, system-ui, sans-serif';
    ctx.fillStyle = muted;
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    for (let k = 0; k <= 2; k += 1) {
      const y = Math.round(pad.t + ph - (ph * k) / 2) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + pw, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round((yMax * k) / 2)} %`, pad.l - 6, y + 4);
    }
    const bw = pw / nb;
    bins.forEach((c, k) => {
      const v = (c / n) * 100;
      const bh = (v / yMax) * ph;
      ctx.fillStyle = (k + 0.5) * step > thr ? heat : base;
      ctx.fillRect(pad.l + k * bw + 1, pad.t + ph - bh, Math.max(1, bw - 2), bh);
    });
    ctx.fillStyle = muted;
    ctx.textAlign = 'center';
    for (let v = 0; v <= maxV; v += 1) ctx.fillText(`${v}${v === maxV ? '+' : ''}`, pad.l + (v / maxV) * pw, h - 8);
    const x = Math.round(pad.l + (Math.min(thr, maxV) / maxV) * pw) + 0.5;
    ctx.strokeStyle = css('--text', '#0f1e2c');
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, pad.t - 4);
    ctx.lineTo(x, pad.t + ph);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = 'left';
    ctx.fillStyle = css('--text', '#0f1e2c');
    ctx.fillText(`umbral ${String(thr).replace('.', ',')} °C`, x + 4, pad.t + 6);
  }

  function drawAll() {
    document.querySelectorAll('canvas[data-pw-map]').forEach(drawMap);
    document.querySelectorAll('canvas[data-pw-hist]').forEach(drawHist);
  }

  /* Pestañas accesibles (Toma 1 / Toma 2 / Cambio): role="tab" con aria-controls. */
  function initTabs() {
    document.querySelectorAll('[data-sr-tabs]').forEach((list) => {
      const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
      const select = (tab, focus) => {
        tabs.forEach((t) => {
          const on = t === tab;
          t.setAttribute('aria-selected', String(on));
          t.tabIndex = on ? 0 : -1;
          const panel = document.getElementById(t.getAttribute('aria-controls'));
          if (panel) panel.hidden = !on;
        });
        if (focus) tab.focus();
        drawAll();
      };
      list.addEventListener('click', (e) => {
        const tab = e.target.closest('[role="tab"]');
        if (tab) select(tab, false);
      });
      list.addEventListener('keydown', (e) => {
        const i = tabs.indexOf(document.activeElement);
        if (i < 0) return;
        const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (next === undefined) return;
        e.preventDefault();
        select(tabs[(next + tabs.length) % tabs.length], true);
      });
    });
  }

  function init() {
    if (!document.querySelector('[data-pw-map],[data-pw-hist]')) return;
    initTabs();
    drawAll();
    let raf = 0;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(drawAll);
    });
    // Los <details> cerrados no tienen tamaño: se dibuja al abrirlos.
    document.querySelectorAll('details').forEach((d) => d.addEventListener('toggle', drawAll));
    new MutationObserver(drawAll).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }

  window.TermoPiePuntual = { decode, ZONA_KEYS };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
