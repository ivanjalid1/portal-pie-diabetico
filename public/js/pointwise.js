/* Mapas punto a punto (canvas) a partir de las grillas canónicas del análisis.
 * Los datos llegan en <script type="application/json" data-pw-data id="..."> (no se ejecutan).
 * Lienzos:
 *   <canvas data-pw-map="1:izq|1:der|1:dt|cambio:izq|cambio:der" data-pw-src="id">
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

  function lutColor(lut, t) {
    const i = Math.max(0, Math.min(lut.length - 1, Math.round(t * (lut.length - 1))));
    return lut[i];
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
      tomas[t.toma] = { ...t, izqG: izq, derG: der, dt };
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

  function sizeCanvas(canvas, aspect) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = canvas.clientWidth || 160;
    const cssH = Math.round(cssW * aspect);
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: cssW, h: cssH };
  }

  /* Pinta una grilla escalada (suave) con una función de color; NaN → color de "sin dato" o transparente. */
  function paintGrid(ctx, w, h, W, H, grid, colorOf, { flip = false, gray = null, grayMask = null } = {}) {
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const octx = off.getContext('2d');
    const img = octx.createImageData(W, H);
    for (let r = 0; r < H; r += 1) {
      for (let c = 0; c < W; c += 1) {
        const src = r * W + (flip ? W - 1 - c : c);
        const o = (r * W + c) * 4;
        const v = grid[src];
        if (ok(v)) {
          const col = colorOf(v);
          img.data[o] = col[0];
          img.data[o + 1] = col[1];
          img.data[o + 2] = col[2];
          img.data[o + 3] = 255;
        } else if (gray && grayMask && grayMask(src)) {
          img.data[o] = gray[0];
          img.data[o + 1] = gray[1];
          img.data[o + 2] = gray[2];
          img.data[o + 3] = 255;
        }
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, 0, 0, w, h);
  }

  function zoneGuides(ctx, w, h, { labels = false } = {}) {
    ctx.save();
    ctx.strokeStyle = 'rgba(15,30,44,0.28)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    for (const f of ZONAS) {
      const y = Math.round(f * h) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.restore();
    if (!labels) return;
    ctx.save();
    ctx.font = '600 10px Geist, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(15,30,44,0.55)';
    const bounds = [0, ...ZONAS, 1];
    for (let k = 0; k < 4; k += 1) ctx.fillText(ZONA_NOMBRES[k], 3, bounds[k] * h + 12);
    ctx.restore();
  }

  /* Contorno de las celdas con |ΔT| > umbral (bordes entre celda caliente y no caliente). */
  function contour(ctx, w, h, W, H, grid, thr) {
    const cw = w / W;
    const ch = h / H;
    const hot = (r, c) => r >= 0 && c >= 0 && r < H && c < W && ok(grid[r * W + c]) && Math.abs(grid[r * W + c]) > thr;
    ctx.save();
    ctx.strokeStyle = css('--text', '#0f1e2c');
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let r = 0; r < H; r += 1) {
      for (let c = 0; c < W; c += 1) {
        if (!hot(r, c)) continue;
        const x = c * cw;
        const y = r * ch;
        if (!hot(r - 1, c)) {
          ctx.moveTo(x, y);
          ctx.lineTo(x + cw, y);
        }
        if (!hot(r + 1, c)) {
          ctx.moveTo(x, y + ch);
          ctx.lineTo(x + cw, y + ch);
        }
        if (!hot(r, c - 1)) {
          ctx.moveTo(x, y);
          ctx.lineTo(x, y + ch);
        }
        if (!hot(r, c + 1)) {
          ctx.moveTo(x + cw, y);
          ctx.lineTo(x + cw, y + ch);
        }
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  function marker(ctx, w, h, W, H, hs) {
    if (!hs) return;
    const x = ((hs.col + 0.5) * w) / W;
    const y = ((hs.fila + 0.5) * h) / H;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = css('--text', '#0f1e2c');
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(x, y, 8.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawMap(canvas) {
    const s = source(canvas.dataset.pwSrc);
    if (!s) return;
    const [which, foot] = canvas.dataset.pwMap.split(':');
    const { ctx, w, h } = sizeCanvas(canvas, s.H / s.W);
    ctx.clearRect(0, 0, w, h);
    const gray = [203, 213, 224];
    const lut = s.d.lut;
    if (which === 'cambio') {
      if (!s.cambio) return;
      const g = s.cambio[foot];
      const med = s.cambio[`${foot}Mediana`] || 0;
      paintGrid(ctx, w, h, s.W, s.H, g, (v) => diverging(v - med, 3), { flip: foot === 'der' });
      zoneGuides(ctx, w, h);
      return;
    }
    const t = s.tomas[which];
    if (!t) return;
    if (foot === 'dt') {
      const mask = (i) => ok(t.izqG[i]) || ok(t.derG[i]);
      paintGrid(ctx, w, h, s.W, s.H, t.dt, (v) => diverging(v, 3), { gray, grayMask: mask });
      zoneGuides(ctx, w, h, { labels: true });
      contour(ctx, w, h, s.W, s.H, t.dt, s.d.umbralPixel);
      marker(ctx, w, h, s.W, s.H, t.metricas && t.metricas.hotspot);
      return;
    }
    const g = foot === 'izq' ? t.izqG : t.derG;
    paintGrid(ctx, w, h, s.W, s.H, g, (v) => lutColor(lut, (v - s.lo) / (s.hi - s.lo)), { flip: foot === 'der' });
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

  function init() {
    if (!document.querySelector('[data-pw-map],[data-pw-hist]')) return;
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
