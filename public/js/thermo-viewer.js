/* Visor de termogramas al estilo del editor de Fluke SmartView.
   Renderiza en el navegador, sobre canvas, la matriz de temperaturas compacta
   «TPV1» (src/imaging/thermalArray.js) con la LUT de la paleta elegida:
   fusión con la foto visible (o, sin foto, con la térmica en grises), PIP,
   nivel y rango, saturación, alarma de color, punto, caja, zoom, giro y
   desplazamiento. Todo el recoloreo es de 320 × 240 píxeles: fluido al
   arrastrar los controles. */
(function () {
  'use strict';

  const lutsEl = document.querySelector('[data-tv-luts]');
  if (!lutsEl) return;
  const LUTS = JSON.parse(lutsEl.textContent);

  const SCALE = { min: -30, max: 90 };
  // Registro IR → foto visible de la TiS75 (src/imaging/is2.js#FUSION).
  const FUSION = { W: 640, H: 480, x: 80, y: 60, w: 480, h: 360 };
  // Escala por defecto: la configurada en la cámara de la cohorte.
  const FIXED = { lo: 24, hi: 35 };
  const nf1 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtC = (v) => (Number.isFinite(v) ? `${nf1.format(v)} °C` : '—');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const r1 = (v) => Math.round(v * 10) / 10;

  /* ---------------- Datos ---------------- */

  const cache = new Map();
  function fetchOnce(url, kind) {
    if (!cache.has(url)) {
      cache.set(
        url,
        fetch(url, { credentials: 'same-origin' }).then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return kind === 'bin' ? r.arrayBuffer() : r.blob().then((b) => createImageBitmap(b));
        }),
      );
      cache.get(url).catch(() => cache.delete(url));
    }
    return cache.get(url);
  }

  /** Decodifica «TPV1» → { w, h, data: Float32Array (NaN = sin dato), estadísticos }. */
  function decodeThermal(buf) {
    const dv = new DataView(buf);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'TPV1') throw new Error('formato');
    const w = dv.getUint16(4, true);
    const h = dv.getUint16(6, true);
    const origin = dv.getFloat32(8, true);
    const step = dv.getFloat32(12, true);
    const n = w * h;
    const data = new Float32Array(n);
    const finite = [];
    for (let i = 0; i < n; i += 1) {
      const q = dv.getUint16(16 + i * 2, true);
      if (q === 0xffff) data[i] = NaN;
      else {
        data[i] = origin + q * step;
        finite.push(data[i]);
      }
    }
    const sorted = Float32Array.from(finite).sort();
    const pct = (p) => (sorted.length ? sorted[Math.round(p * (sorted.length - 1))] : 0);
    return { w, h, data, min: pct(0), max: pct(1), p01: pct(0.01), p995: pct(0.995), p50: pct(0.5) };
  }

  /* ---------------- Visor ---------------- */

  function Viewer(root) {
    const $ = (s) => root.querySelector(s);
    const $$ = (s) => [...root.querySelectorAll(s)];
    const ui = $('[data-tv-ui]');
    const mask = ui.classList.contains('tv--mask');
    const sources = JSON.parse($('[data-tv-sources]').textContent);
    const fbEl = $('[data-tv-fallback]');
    const fallback = fbEl ? JSON.parse(fbEl.textContent) : {};
    const stage = $('[data-tv-stage]');
    const canvas = $('[data-tv-canvas]');
    const ctx = canvas.getContext('2d');
    const status = $('[data-tv-status]');

    const st = {
      toma: Number(root.dataset.tvTomaInicial) || sources[sources.length - 1].toma,
      rep: null,
      T: null,
      photo: null,
      palette: 'alto_contraste',
      sat: 'estandar',
      alarm: { mode: 'none', a: null, b: null },
      // Escala fija de la cámara (24–35 °C) por defecto, como las miniaturas;
      // la herramienta de máscaras sigue con la escala automática.
      lo: FIXED.lo,
      hi: FIXED.hi,
      auto: mask,
      blend: Number($('[data-tv-blend]').value),
      pip: !mask,
      // crop: encuadre de los pies; straight: giro sugerido para enderezar (sólo vista).
      view: { zoom: 1, rot: 0, px: 0, py: 0, crop: !mask, straight: false },
      spot: null,
      hover: null,
      box: null,
      boxTool: false,
      alarmCount: 0,
      loadSeq: 0,
    };

    // Capas fuera de pantalla.
    const irC = document.createElement('canvas');
    const grayC = document.createElement('canvas');
    const scene = document.createElement('canvas');
    scene.width = FUSION.W;
    scene.height = FUSION.H;
    const sctx = scene.getContext('2d');
    let irImg = null;
    let grayImg = null;

    /* ---------- Recoloreo (LUT) ---------- */

    const inAlarm = (t) => {
      const { mode, a, b } = st.alarm;
      if (mode === 'above') return t >= a;
      if (mode === 'below') return t <= a;
      if (mode === 'between') return t >= Math.min(a, b) && t <= Math.max(a, b);
      return false;
    };

    function recolor() {
      const T = st.T;
      if (!T) return;
      const lut = LUTS[st.palette];
      const d = irImg.data;
      const g = grayImg.data;
      const span = Math.max(0.1, st.hi - st.lo);
      const A = Math.round((1 - st.blend / 100) * 255);
      const alarmOn = st.alarm.mode !== 'none';
      let count = 0;
      let valid = 0;
      for (let i = 0, o = 0; i < T.data.length; i += 1, o += 4) {
        const t = T.data[i];
        if (Number.isNaN(t)) {
          d[o + 3] = 0;
          g[o] = g[o + 1] = g[o + 2] = 0;
          g[o + 3] = 255;
          continue;
        }
        valid += 1;
        const k = (t - st.lo) / span;
        const kc = k < 0 ? 0 : k > 1 ? 1 : k;
        const gv = Math.round(kc * 255);
        g[o] = g[o + 1] = g[o + 2] = gv;
        g[o + 3] = 255;
        if (alarmOn) {
          if (inAlarm(t)) {
            const li = Math.round(kc * 255) * 3;
            d[o] = lut[li];
            d[o + 1] = lut[li + 1];
            d[o + 2] = lut[li + 2];
            d[o + 3] = 255;
            count += 1;
          } else {
            d[o] = d[o + 1] = d[o + 2] = gv;
            d[o + 3] = A;
          }
        } else if (k < 0 && st.sat === 'estandar') {
          // Bajo el mínimo no se colorea: se ve el fondo con un velo oscuro (como en la cámara).
          d[o] = 30;
          d[o + 1] = 20;
          d[o + 2] = 10;
          d[o + 3] = Math.round(A * 0.55);
        } else {
          const li = Math.round(kc * 255) * 3;
          d[o] = lut[li];
          d[o + 1] = lut[li + 1];
          d[o + 2] = lut[li + 2];
          d[o + 3] = A;
        }
      }
      st.alarmCount = valid ? count / valid : 0;
      irC.getContext('2d').putImageData(irImg, 0, 0);
      grayC.getContext('2d').putImageData(grayImg, 0, 0);
    }

    /* ---------- Composición de la escena (640 × 480) ---------- */

    /**
     * Campo IR dentro de la foto: el registro fijo de la cámara más el
     * desplazamiento medido para esta réplica (sólo si el precálculo lo aplicó).
     */
    function fusionField() {
      const al = st.rep && st.rep.alineacion;
      const dx = al ? clamp(al.dx, -FUSION.x, FUSION.W - FUSION.w - FUSION.x) : 0;
      const dy = al ? clamp(al.dy, -FUSION.y, FUSION.H - FUSION.h - FUSION.y) : 0;
      return { x: FUSION.x + dx, y: FUSION.y + dy, w: FUSION.w, h: FUSION.h };
    }

    function irRect() {
      return st.pip && st.photo ? fusionField() : { x: 0, y: 0, w: FUSION.W, h: FUSION.H };
    }

    function composeScene() {
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = 'high';
      sctx.fillStyle = '#0b0f14';
      sctx.fillRect(0, 0, FUSION.W, FUSION.H);
      if (!st.T) return;
      if (st.photo) {
        const f = fusionField();
        if (st.pip) sctx.drawImage(st.photo, 0, 0, FUSION.W, FUSION.H);
        else sctx.drawImage(st.photo, f.x, f.y, f.w, f.h, 0, 0, FUSION.W, FUSION.H);
      } else sctx.drawImage(grayC, 0, 0, FUSION.W, FUSION.H);
      const r = irRect();
      sctx.drawImage(irC, r.x, r.y, r.w, r.h);
    }

    /* ---------- Vista (zoom, giro, encuadre, desplazamiento) ---------- */

    /** Recuadro de la escena que se ajusta al lienzo: los pies (encuadre) o la escena completa. */
    function viewRect() {
      const e = st.view.crop && st.rep && st.rep.encuadre;
      if (!e || !st.T) return { x: 0, y: 0, w: FUSION.W, h: FUSION.H };
      const a = irToScene(e[0], e[1]);
      const b = irToScene(e[2], e[3]);
      return { x: a.x, y: a.y, w: Math.max(8, b.x - a.x), h: Math.max(8, b.y - a.y) };
    }
    const straightAngle = () => (st.view.straight && st.rep && st.rep.giro ? st.rep.giro : 0);

    let dpr = 1;
    function viewMatrix() {
      const DW = canvas.width;
      const DH = canvas.height;
      const rot = ((st.view.rot % 4) + 4) % 4;
      const ang = rot * 90 + straightAngle();
      const v = viewRect();
      const c = Math.abs(Math.cos((ang * Math.PI) / 180));
      const s = Math.abs(Math.sin((ang * Math.PI) / 180));
      const RW = c * v.w + s * v.h;
      const RH = s * v.w + c * v.h;
      const fit = Math.min(DW / RW, DH / RH) * st.view.zoom;
      return new DOMMatrix()
        .translate(DW / 2 + st.view.px * DW, DH / 2 + st.view.py * DH)
        .rotate(ang)
        .scale(fit)
        .translate(-(v.x + v.w / 2), -(v.y + v.h / 2));
    }
    const sceneToIr = (sx, sy) => {
      const r = irRect();
      return { x: ((sx - r.x) / r.w) * st.T.w, y: ((sy - r.y) / r.h) * st.T.h };
    };
    const irToScene = (x, y) => {
      const r = irRect();
      return { x: r.x + (x / st.T.w) * r.w, y: r.y + (y / st.T.h) * r.h };
    };
    function eventToIr(ev) {
      const rect = canvas.getBoundingClientRect();
      const dx = ((ev.clientX - rect.left) / rect.width) * canvas.width;
      const dy = ((ev.clientY - rect.top) / rect.height) * canvas.height;
      const p = viewMatrix().inverse().transformPoint(new DOMPoint(dx, dy));
      return sceneToIr(p.x, p.y);
    }
    function tempAt(p) {
      if (!st.T || !p) return NaN;
      const x = Math.floor(p.x);
      const y = Math.floor(p.y);
      if (x < 0 || y < 0 || x >= st.T.w || y >= st.T.h) return NaN;
      return st.T.data[y * st.T.w + x];
    }

    function drawMarker(m, p, label, strong) {
      const s = irToScene(Math.floor(p.x) + 0.5, Math.floor(p.y) + 0.5);
      const q = m.transformPoint(new DOMPoint(s.x, s.y));
      const L = 7 * dpr;
      ctx.save();
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.moveTo(q.x - L, q.y);
      ctx.lineTo(q.x + L, q.y);
      ctx.moveTo(q.x, q.y - L);
      ctx.lineTo(q.x, q.y + L);
      ctx.stroke();
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      if (label) {
        ctx.font = `${strong ? 600 : 500} ${12.5 * dpr}px Geist, system-ui, sans-serif`;
        ctx.textBaseline = 'bottom';
        const tw = ctx.measureText(label).width;
        let tx = q.x - tw / 2;
        let ty = q.y - L - 4 * dpr;
        tx = clamp(tx, 4 * dpr, canvas.width - tw - 4 * dpr);
        if (ty < 18 * dpr) ty = q.y + L + 18 * dpr;
        ctx.lineWidth = 3 * dpr;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.strokeText(label, tx, ty);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, tx, ty);
      }
      ctx.restore();
    }

    function drawView() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0b0f14';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!st.T) return;
      const m = viewMatrix();
      ctx.setTransform(m);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(scene, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (st.box) {
        const b = st.box;
        const pts = [
          [b.x0, b.y0],
          [b.x1, b.y0],
          [b.x1, b.y1],
          [b.x0, b.y1],
        ].map(([x, y]) => {
          const s = irToScene(x, y);
          return m.transformPoint(new DOMPoint(s.x, s.y));
        });
        ctx.save();
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.lineWidth = 3 * dpr;
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.stroke();
        ctx.setLineDash([6 * dpr, 4 * dpr]);
        ctx.lineWidth = 1.5 * dpr;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        ctx.restore();
      }
      if (st.spot && !mask) drawMarker(m, st.spot, fmtC(tempAt(st.spot)), true);
      if (st.hover) {
        const t = tempAt(st.hover);
        if (Number.isFinite(t)) drawMarker(m, st.hover, fmtC(t), false);
      }
    }

    let pending = 0;
    let frame = 0;
    const COLOR = 4;
    const SCENE = 2;
    const VIEW = 1;
    function invalidate(level) {
      pending |= level;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const p = pending;
        pending = 0;
        if (p & COLOR) {
          recolor();
          updateBar();
          updateReadout();
        }
        if (p & (COLOR | SCENE)) composeScene();
        drawView();
      });
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      invalidate(VIEW);
    }
    new ResizeObserver(resize).observe(stage);

    /* ---------- Barra de color (vertical, a la derecha) ---------- */

    const bar = $('[data-tv-bar]');
    const barCtx = bar.getContext('2d');
    const barImg = barCtx.createImageData(1, 256);
    function updateBar() {
      const lut = LUTS[st.palette];
      const alarmOn = st.alarm.mode !== 'none';
      for (let j = 0; j < 256; j += 1) {
        const k = 1 - j / 255;
        const t = st.lo + k * (st.hi - st.lo);
        const li = Math.round(k * 255) * 3;
        let [r, g, b] = [lut[li], lut[li + 1], lut[li + 2]];
        if (alarmOn && !inAlarm(t)) {
          const y = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
          r = g = b = Math.round(y * 0.55 + 200 * 0.45);
        }
        const o = j * 4;
        barImg.data[o] = r;
        barImg.data[o + 1] = g;
        barImg.data[o + 2] = b;
        barImg.data[o + 3] = 255;
      }
      barCtx.putImageData(barImg, 0, 0);
      const ticks = $('[data-tv-ticks]');
      const n = 7;
      ticks.innerHTML = '';
      for (let i = 0; i < n; i += 1) {
        const s = document.createElement('span');
        s.style.top = `${(i / (n - 1)) * 100}%`;
        s.textContent = nf1.format(st.hi - (i / (n - 1)) * (st.hi - st.lo));
        ticks.appendChild(s);
      }
      const mark = (el, v) => {
        const ok = alarmOn && Number.isFinite(v) && v >= st.lo && v <= st.hi;
        el.hidden = !ok;
        if (ok) el.style.top = `${((st.hi - v) / (st.hi - st.lo)) * 100}%`;
      };
      mark($('[data-tv-mark="lo"]'), st.alarm.a);
      mark($('[data-tv-mark="hi"]'), st.alarm.mode === 'between' ? st.alarm.b : NaN);
      updateSpan();
    }

    /* ---------- Nivel y rango (barra vertical −30 a 90 °C) ---------- */

    const track = $('[data-tv-span-track]');
    const pos = (t) => clamp(((t - SCALE.min) / (SCALE.max - SCALE.min)) * 100, 0, 100);
    function updateSpan() {
      const lut = LUTS[st.palette];
      const a = pos(st.lo);
      const b = pos(st.hi);
      const stops = [];
      for (let i = 0; i <= 12; i += 1) {
        const li = Math.round((i / 12) * 255) * 3;
        stops.push(`rgb(${lut[li]},${lut[li + 1]},${lut[li + 2]}) ${(a + ((b - a) * i) / 12).toFixed(2)}%`);
      }
      track.style.background = `linear-gradient(to top, #0b0f14 0%, #0b0f14 ${a.toFixed(2)}%, ${stops.join(', ')}, #f3f5f8 ${b.toFixed(2)}%, #f3f5f8 100%)`;
      const H = track.clientHeight;
      const ys = {};
      for (const [k, v] of [
        ['hi', st.hi],
        ['mid', (st.lo + st.hi) / 2],
        ['lo', st.lo],
      ]) {
        const el = $(`[data-tv-handle="${k}"]`);
        el.style.bottom = `${pos(v)}%`;
        ys[k] = H * (1 - pos(v) / 100);
        const inp = $(`[data-tv-spin="${k}"]`);
        if (document.activeElement !== inp) inp.value = r1(v).toFixed(1);
      }
      // Cajas numéricas: a la altura de su asa, sin superponerse.
      const gap = 30;
      let yMid = clamp(ys.mid, gap + 12, H - gap - 12);
      let yHi = Math.min(ys.hi, yMid - gap);
      let yLo = Math.max(ys.lo, yMid + gap);
      if (yHi < 12) {
        yHi = 12;
        yMid = Math.max(yMid, yHi + gap);
        yLo = Math.max(yLo, yMid + gap);
      }
      if (yLo > H - 12) {
        yLo = H - 12;
        yMid = Math.min(yMid, yLo - gap);
        yHi = Math.min(yHi, yMid - gap);
      }
      $('[data-tv-spin="hi"]').style.top = `${yHi}px`;
      $('[data-tv-spin="mid"]').style.top = `${yMid}px`;
      $('[data-tv-spin="lo"]').style.top = `${yLo}px`;
      $('[data-tv-auto]').checked = st.auto;
    }

    function setRange(lo, hi, { manual = true } = {}) {
      lo = r1(clamp(lo, SCALE.min, SCALE.max - 0.2));
      hi = r1(clamp(hi, lo + 0.2, SCALE.max));
      st.lo = lo;
      st.hi = hi;
      if (manual) st.auto = false;
      clampAlarm();
      invalidate(COLOR);
    }
    function autoRange() {
      if (!st.T) return;
      st.auto = true;
      setRange(Math.floor(st.T.p01 * 10) / 10, Math.ceil(st.T.p995 * 10) / 10, { manual: false });
    }

    function handleDrag(kind, ev) {
      const el = ev.currentTarget;
      el.setPointerCapture(ev.pointerId);
      const start = { lo: st.lo, hi: st.hi };
      const move = (e) => {
        const r = track.getBoundingClientRect();
        const t = SCALE.min + (1 - clamp((e.clientY - r.top) / r.height, 0, 1)) * (SCALE.max - SCALE.min);
        if (kind === 'hi') setRange(st.lo, Math.max(t, st.lo + 0.2));
        else if (kind === 'lo') setRange(Math.min(t, st.hi - 0.2), st.hi);
        else {
          const half = (start.hi - start.lo) / 2;
          const c = clamp(t, SCALE.min + half, SCALE.max - half);
          setRange(c - half, c + half);
        }
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }
    const nudge = (kind, d) => {
      if (kind === 'hi') setRange(st.lo, st.hi + d);
      else if (kind === 'lo') setRange(st.lo + d, st.hi);
      else setRange(st.lo + d, st.hi + d);
    };
    $$('[data-tv-handle]').forEach((h) => {
      const kind = h.dataset.tvHandle;
      h.addEventListener('pointerdown', (ev) => handleDrag(kind, ev));
      h.addEventListener('keydown', (ev) => {
        const d = ev.shiftKey ? 1 : 0.1;
        if (ev.key === 'ArrowUp' || ev.key === 'ArrowRight') nudge(kind, d);
        else if (ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') nudge(kind, -d);
        else return;
        ev.preventDefault();
      });
      h.addEventListener(
        'wheel',
        (ev) => {
          ev.preventDefault();
          nudge(kind, ev.deltaY < 0 ? 0.1 : -0.1);
        },
        { passive: false },
      );
    });
    $$('[data-tv-spin]').forEach((inp) =>
      inp.addEventListener('change', () => {
        const v = Number(String(inp.value).replace(',', '.'));
        if (!Number.isFinite(v)) return updateSpan();
        const k = inp.dataset.tvSpin;
        if (k === 'hi') setRange(st.lo, Math.max(v, st.lo + 0.2));
        else if (k === 'lo') setRange(Math.min(v, st.hi - 0.2), st.hi);
        else {
          const half = (st.hi - st.lo) / 2;
          setRange(v - half, v + half);
        }
      }),
    );
    const fixedBtn = $('[data-tv-fixed]');
    if (fixedBtn) fixedBtn.addEventListener('click', () => setRange(FIXED.lo, FIXED.hi));
    $('[data-tv-auto]').addEventListener('change', (ev) => {
      if (ev.target.checked) autoRange();
      else st.auto = false;
    });

    /* ---------- Alarma de color ---------- */

    const alarmSel = $('[data-tv-alarm-mode]');
    const alarmIn = $('[data-tv-alarm]');
    const alarmIn2 = $('[data-tv-alarm2]');
    function alarmBounds() {
      if (!st.T) return { min: st.lo, max: st.hi };
      return {
        min: Math.floor(Math.min(st.T.min, st.lo) * 10) / 10,
        max: Math.ceil(Math.max(st.T.max, st.hi) * 10) / 10,
      };
    }
    function clampAlarm() {
      const { min, max } = alarmBounds();
      for (const inp of [alarmIn, alarmIn2]) {
        inp.min = String(min);
        inp.max = String(max);
      }
      if (st.alarm.a !== null) st.alarm.a = clamp(st.alarm.a, min, max);
      if (st.alarm.b !== null) st.alarm.b = clamp(st.alarm.b, min, max);
      syncAlarm();
    }
    function syncAlarm() {
      const { mode, a, b } = st.alarm;
      const on = mode !== 'none';
      $('[data-tv-alarm-box]').hidden = !on;
      alarmIn2.hidden = mode !== 'between';
      if (!on) return;
      alarmIn.value = String(a);
      alarmIn2.value = String(b);
      const lab = $('[data-tv-alarm-label]');
      if (mode === 'above') lab.textContent = `Alarma de color ≥ ${fmtC(a)}`;
      else if (mode === 'below') lab.textContent = `Alarma de color ≤ ${fmtC(a)}`;
      else lab.textContent = `Alarma de color entre ${nf1.format(Math.min(a, b))} y ${fmtC(Math.max(a, b))}`;
      alarmIn.setAttribute('aria-valuetext', lab.textContent);
    }
    alarmSel.addEventListener('change', () => {
      const prev = st.alarm.mode;
      const mode = alarmSel.value;
      const span = st.hi - st.lo;
      st.alarm.mode = mode;
      if (mode === 'above' && (prev === 'none' || st.alarm.a === null)) st.alarm.a = r1(st.lo + span * 0.75);
      if (mode === 'below' && (prev === 'none' || st.alarm.a === null)) st.alarm.a = r1(st.lo + span * 0.3);
      if (mode === 'between') {
        if (st.alarm.a === null || prev === 'none') st.alarm.a = r1(st.lo + span * 0.5);
        st.alarm.b = r1(Math.min(st.hi, st.alarm.a + span * 0.25));
      }
      // Como en la cámara: con alarma, el resto de la imagen pasa a la foto.
      if (prev === 'none' && mode !== 'none') setBlend(100);
      clampAlarm();
      invalidate(COLOR);
    });
    alarmIn.addEventListener('input', () => {
      st.alarm.a = Number(alarmIn.value);
      syncAlarm();
      invalidate(COLOR);
    });
    alarmIn2.addEventListener('input', () => {
      st.alarm.b = Number(alarmIn2.value);
      syncAlarm();
      invalidate(COLOR);
    });

    /* ---------- Paleta, saturación, fusión y PIP ---------- */

    const palSel = $('[data-tv-palette]');
    const swatch = $('[data-tv-swatch]');
    function paintSwatch() {
      const lut = LUTS[st.palette];
      const stops = [0, 0.25, 0.5, 0.75, 1].map((k) => {
        const li = Math.round(k * 255) * 3;
        return `rgb(${lut[li]},${lut[li + 1]},${lut[li + 2]}) ${k * 100}%`;
      });
      swatch.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
    }
    palSel.addEventListener('change', () => {
      st.palette = palSel.value;
      paintSwatch();
      invalidate(COLOR);
    });
    $('[data-tv-sat]').addEventListener('change', (ev) => {
      st.sat = ev.target.value;
      invalidate(COLOR);
    });

    const blendIn = $('[data-tv-blend]');
    function setBlend(v) {
      st.blend = clamp(Math.round(v), 0, 100);
      blendIn.value = String(st.blend);
      const out = $('[data-tv-blend-out]');
      out.textContent =
        st.blend === 0
          ? 'infrarrojo completo'
          : st.blend === 100
            ? 'visible completo'
            : `${100 - st.blend} % infrarrojo`;
      blendIn.setAttribute('aria-valuetext', out.textContent);
    }
    blendIn.addEventListener('input', () => {
      setBlend(Number(blendIn.value));
      invalidate(COLOR);
    });
    const pipIn = $('[data-tv-pip]');
    if (pipIn) {
      pipIn.addEventListener('change', () => {
        st.pip = pipIn.checked;
        st.box = null;
        invalidate(SCENE);
      });
    }

    /* ---------- Pestañas del panel ---------- */

    const tabs = $$('[data-tv-tab]');
    function selectTab(btn) {
      tabs.forEach((t) => {
        const on = t === btn;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        $(`[data-tv-pane="${t.dataset.tvTab}"]`).hidden = !on;
      });
    }
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => selectTab(t));
      t.addEventListener('keydown', (ev) => {
        const d = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        const n = tabs[(i + d + tabs.length) % tabs.length];
        selectTab(n);
        n.focus();
      });
    });

    /* ---------- Herramientas de vista ---------- */

    const zoomSel = $('[data-tv-zoom-sel]');
    const ZOOMS = [1, 1.5, 2, 3, 4];
    function setZoom(z) {
      st.view.zoom = z;
      if (z === 1) st.view.px = st.view.py = 0;
      if (zoomSel) zoomSel.value = String(z);
      invalidate(VIEW);
    }
    if (zoomSel) {
      zoomSel.addEventListener('change', () => setZoom(Number(zoomSel.value)));
      $$('[data-tv-zoom]').forEach((b) =>
        b.addEventListener('click', () => {
          const i = ZOOMS.indexOf(st.view.zoom);
          setZoom(ZOOMS[clamp(i + Number(b.dataset.tvZoom), 0, ZOOMS.length - 1)]);
        }),
      );
      $$('[data-tv-rot]').forEach((b) =>
        b.addEventListener('click', () => {
          st.view.rot = (st.view.rot + Number(b.dataset.tvRot) + 4) % 4;
          invalidate(VIEW);
        }),
      );
      // Encuadre de los pies y enderezado: sólo cambian la vista, nunca los datos.
      for (const [sel, key] of [
        ['[data-tv-crop]', 'crop'],
        ['[data-tv-straight]', 'straight'],
      ]) {
        const b = $(sel);
        if (!b) continue;
        b.addEventListener('click', () => {
          st.view[key] = !st.view[key];
          st.view.px = st.view.py = 0;
          syncViewButtons();
          invalidate(VIEW);
        });
      }
      $$('[data-tv-pan]').forEach((b) =>
        b.addEventListener('click', () => {
          const [dx, dy] = b.dataset.tvPan.split(',').map(Number);
          if (!dx && !dy) st.view.px = st.view.py = 0;
          else {
            const lim = Math.max(0.15, (st.view.zoom - 1) / 2 + 0.15);
            st.view.px = clamp(st.view.px - dx * 0.1, -lim, lim);
            st.view.py = clamp(st.view.py - dy * 0.1, -lim, lim);
          }
          invalidate(VIEW);
        }),
      );
    }
    function syncViewButtons() {
      const crop = $('[data-tv-crop]');
      const straight = $('[data-tv-straight]');
      if (crop) {
        crop.disabled = !(st.rep && st.rep.encuadre);
        crop.setAttribute('aria-pressed', String(Boolean(st.view.crop && !crop.disabled)));
      }
      if (straight) {
        const g = st.rep && st.rep.giro ? st.rep.giro : 0;
        straight.disabled = !g;
        straight.setAttribute('aria-pressed', String(Boolean(st.view.straight && g)));
        straight.title = g
          ? `Girar la vista ${Math.abs(g)}° para enderezar los pies (sólo vista; los datos no cambian)`
          : 'Los pies ya están derechos';
      }
    }

    /* ---------- Puntero: lectura, punto y caja ---------- */

    const boxBtn = $('[data-tv-box-tool]');
    if (boxBtn) {
      boxBtn.addEventListener('click', () => {
        st.boxTool = !st.boxTool;
        boxBtn.setAttribute('aria-pressed', String(st.boxTool));
        stage.classList.toggle('is-box', st.boxTool);
      });
    }
    let down = null;
    stage.addEventListener('pointermove', (ev) => {
      if (!st.T) return;
      const p = eventToIr(ev);
      const inside = p.x >= 0 && p.y >= 0 && p.x < st.T.w && p.y < st.T.h;
      st.hover = inside && ev.pointerType !== 'touch' ? p : null;
      if (down && st.boxTool) {
        st.box = normBox(down.p, p);
        updateBox();
      }
      updateReadout(inside ? tempAt(p) : NaN);
      invalidate(VIEW);
    });
    stage.addEventListener('pointerleave', () => {
      st.hover = null;
      updateReadout(NaN);
      invalidate(VIEW);
    });
    if (!mask) {
      stage.addEventListener('pointerdown', (ev) => {
        if (!st.T || ev.button !== 0) return;
        down = { p: eventToIr(ev), x: ev.clientX, y: ev.clientY };
        if (st.boxTool) stage.setPointerCapture(ev.pointerId);
      });
      stage.addEventListener('pointerup', (ev) => {
        if (!down) return;
        const p = eventToIr(ev);
        const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 4;
        if (st.boxTool && moved) {
          st.box = normBox(down.p, p);
          updateBox();
        } else if (!moved && p.x >= 0 && p.y >= 0 && p.x < st.T.w && p.y < st.T.h) {
          st.spot = p;
          updateReadout();
        }
        down = null;
        invalidate(VIEW);
      });
    }
    function normBox(a, b) {
      const W = st.T.w;
      const H = st.T.h;
      return {
        x0: clamp(Math.floor(Math.min(a.x, b.x)), 0, W),
        y0: clamp(Math.floor(Math.min(a.y, b.y)), 0, H),
        x1: clamp(Math.ceil(Math.max(a.x, b.x)), 0, W),
        y1: clamp(Math.ceil(Math.max(a.y, b.y)), 0, H),
      };
    }
    function updateBox() {
      const read = $('[data-tv-box-read]');
      if (!read) return;
      const b = st.box;
      if (!b || b.x1 - b.x0 < 1 || b.y1 - b.y0 < 1) {
        read.hidden = true;
        return;
      }
      let mn = Infinity;
      let mx = -Infinity;
      let sum = 0;
      let n = 0;
      for (let y = b.y0; y < b.y1; y += 1) {
        for (let x = b.x0; x < b.x1; x += 1) {
          const t = st.T.data[y * st.T.w + x];
          if (Number.isNaN(t)) continue;
          if (t < mn) mn = t;
          if (t > mx) mx = t;
          sum += t;
          n += 1;
        }
      }
      read.hidden = false;
      $('[data-tv-box="max"]').textContent = fmtC(n ? mx : NaN);
      $('[data-tv-box="min"]').textContent = fmtC(n ? mn : NaN);
      $('[data-tv-box="avg"]').textContent = fmtC(n ? sum / n : NaN);
      $('[data-tv-box="n"]').textContent = n.toLocaleString('es-AR');
    }

    let lastCursor = NaN;
    function updateReadout(cursor) {
      if (cursor !== undefined) lastCursor = cursor;
      const set = (k, v) => {
        const el = $(`[data-tv-read="${k}"]`);
        if (el) el.textContent = v;
      };
      set('cursor', fmtC(lastCursor));
      set('spot', st.spot ? fmtC(tempAt(st.spot)) : '—');
      if (st.T) {
        set('max', fmtC(st.T.max));
        set('min', fmtC(st.T.min));
      }
      const al = $('[data-tv-read-alarm]');
      al.hidden = st.alarm.mode === 'none';
      set('alarm', `${nf1.format(st.alarmCount * 100)} % de la imagen`);
    }

    /* ---------- Información y parámetros ---------- */

    function fillInfo() {
      const rep = st.rep;
      const src = sources.find((s) => s.toma === st.toma);
      const info = rep.info || {};
      const emis = info.emisividad ?? fallback.emisividad ?? null;
      const set = (k, v) => ($(`[data-tv-param="${k}"]`).textContent = v);
      set('emisividad', Number.isFinite(emis) ? nf2.format(emis) : '—');
      set('fondo', Number.isFinite(info.fondoC) ? `${nf2.format(info.fondoC)} °C` : '—');
      set('transmision', Number.isFinite(info.transmision) ? `${info.transmision} %` : '—');
      // Algunas cámaras tenían el reloj sin configurar (año < 2020): se aclara.
      const fc = info.fecha ? new Date(info.fecha) : null;
      const fecha = fc
        ? `${fc.toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' })}${fc.getFullYear() < 2020 ? ' (reloj de la cámara sin configurar)' : ''}`
        : fallback.fechas?.[st.toma] || null;
      const esc = info.escalaCamara || fallback.rango || null;
      const origen =
        src.origen === 'real'
          ? `Réplica ${rep.rep} de ${src.reps.length}${rep.calidad !== null ? ` (calidad ${nf2.format(rep.calidad)})` : ''}`
          : src.origen === 'is2'
            ? 'Archivo IS2 del estudio'
            : 'Imagen de demostración (reconstruida de la escala de grises)';
      const rows = [
        ['Cámara', info.camara || 'Fluke TiS75'],
        ['Captura', fecha || '—'],
        ['Toma', `Toma ${st.toma}`],
        ['Origen', origen],
        ['Infrarrojo', st.T ? `${st.T.w} × ${st.T.h} px` : '—'],
        ['Foto visible', st.photo ? '640 × 480 px (privada)' : 'No disponible en este entorno'],
        ...(st.photo
          ? [
              [
                'Registro IR → foto',
                rep.alineacion
                  ? `escala 1,5× desde (${nf1.format(FUSION.x + rep.alineacion.dx)}, ${nf1.format(FUSION.y + rep.alineacion.dy)}) px (ajustado en esta réplica; la cámara indica (80, 60))`
                  : 'escala 1,5× desde (80, 60) px',
              ],
            ]
          : []),
        ...(rep.giro ? [['Giro sugerido para la vista', `${Math.abs(rep.giro)}° (sólo vista)`]] : []),
        ['Emisividad', Number.isFinite(emis) ? nf2.format(emis) : '—'],
        ['Temperatura de fondo', Number.isFinite(info.fondoC) ? `${nf2.format(info.fondoC)} °C` : '—'],
        ['Transmisión', Number.isFinite(info.transmision) ? `${info.transmision} %` : '—'],
        ['Escala de la cámara', esc ? `${nf1.format(esc.min)}–${nf1.format(esc.max)} °C` : '—'],
        ['Temperaturas', 'Conversión lineal del portal (°C aprox.)'],
      ];
      const dl = $('[data-tv-info]');
      dl.innerHTML = '';
      for (const [k, v] of rows) {
        const div = document.createElement('div');
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = k;
        dd.textContent = v;
        div.append(dt, dd);
        dl.appendChild(div);
      }
    }

    /** Avisos automáticos de la réplica (chips) y nota de calidad baja de la toma. */
    function fillQuality() {
      const box = $('[data-tv-quality]');
      if (!box) return;
      const src = sources.find((s) => s.toma === st.toma);
      const rep = st.rep;
      box.hidden = !rep.evaluada;
      if (!rep.evaluada) return;
      const ul = $('[data-tv-flags]');
      ul.innerHTML = '';
      const avisos = rep.avisos || [];
      const items = avisos.length ? avisos : [{ label: 'Sin avisos', ok: true }];
      for (const a of items) {
        const li = document.createElement('li');
        li.className = `badge ${a.ok ? 'badge--ok' : a.grave ? 'badge--warn' : 'badge--muted'}`;
        li.textContent = a.label;
        ul.appendChild(li);
      }
      $('[data-tv-lowq]').hidden = !(src.calidadBaja && rep.mejor);
    }

    /* ---------- Fuente: toma y réplica ---------- */

    const repSel = $('[data-tv-rep]');
    function fillReps() {
      const src = sources.find((s) => s.toma === st.toma);
      const group = $('[data-tv-rep-group]');
      group.hidden = src.reps.length < 2;
      repSel.innerHTML = '';
      src.reps.forEach((r) => {
        const o = document.createElement('option');
        o.value = String(r.rep);
        const parts = [`Réplica ${r.rep}`];
        if (r.calidad !== null && r.calidad !== undefined) parts.push(`calidad ${nf2.format(r.calidad)}`);
        if (r.mejor) parts.push('mejor');
        if (r.noValido) parts.push('no válida');
        const graves = (r.avisos || []).filter((a) => a.grave).length;
        if (graves) parts.push(`${graves} aviso${graves === 1 ? '' : 's'}`);
        o.textContent = parts.join(' · ');
        repSel.appendChild(o);
      });
      const best = src.reps.find((r) => r.mejor) || src.reps[0];
      repSel.value = String(best.rep);
      return best;
    }
    repSel.addEventListener('change', () => {
      const src = sources.find((s) => s.toma === st.toma);
      load(src.reps.find((r) => String(r.rep) === repSel.value));
    });
    $$('[data-tv-toma]').forEach((b, i, all) => {
      const pick = () => {
        all.forEach((x) => {
          const on = x === b;
          x.setAttribute('aria-selected', String(on));
          x.tabIndex = on ? 0 : -1;
        });
        st.toma = Number(b.dataset.tvToma);
        load(fillReps());
      };
      b.addEventListener('click', pick);
      b.addEventListener('keydown', (ev) => {
        const d = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        const n = all[(i + d + all.length) % all.length];
        n.click();
        n.focus();
      });
    });

    async function load(rep) {
      const seq = ++st.loadSeq;
      st.rep = rep;
      // Avisa qué foto se muestra (la revisión de fotos la resalta).
      root.dataset.tvFoto = `${st.toma}-${rep.rep}`;
      root.dispatchEvent(new CustomEvent('tv:foto', { detail: { toma: st.toma, rep: rep.rep } }));
      status.hidden = false;
      status.textContent = 'Cargando termograma…';
      try {
        const [buf, photo] = await Promise.all([
          fetchOnce(rep.termica, 'bin'),
          rep.foto ? fetchOnce(rep.foto, 'img').catch(() => null) : Promise.resolve(null),
        ]);
        if (seq !== st.loadSeq) return;
        const T = decodeThermal(buf);
        st.T = T;
        st.photo = photo;
        st.box = null;
        st.spot = mask ? null : { x: T.w / 2, y: T.h / 2 };
        for (const c of [irC, grayC]) {
          c.width = T.w;
          c.height = T.h;
        }
        irImg = irC.getContext('2d').createImageData(T.w, T.h);
        grayImg = grayC.getContext('2d').createImageData(T.w, T.h);
        if (pipIn) {
          pipIn.disabled = !photo;
          pipIn.checked = Boolean(photo) && st.pip;
          pipIn.closest('[data-tv-pip-label]').classList.toggle('is-disabled', !photo);
        }
        $('[data-tv-nofoto]').hidden = Boolean(photo);
        if (st.auto) autoRange();
        else clampAlarm();
        const r = $('[data-tv-box-read]');
        if (r) r.hidden = true;
        fillInfo();
        fillQuality();
        syncViewButtons();
        st.view.px = st.view.py = 0;
        status.hidden = true;
        invalidate(COLOR);
      } catch {
        if (seq !== st.loadSeq) return;
        status.textContent = 'No se pudo cargar el termograma.';
      }
    }

    /* ---------- Arranque ---------- */
    alarmSel.value = 'none';
    palSel.value = st.palette;
    paintSwatch();
    setBlend(st.blend);
    if (pipIn) pipIn.checked = st.pip;
    const toma0 = sources.find((s) => s.toma === st.toma) ? st.toma : sources[0].toma;
    st.toma = toma0;
    resize();
    load(fillReps());
  }

  document.querySelectorAll('[data-tv]').forEach((root) => {
    if (root.querySelector('[data-tv-ui]')) Viewer(root);
  });
})();
