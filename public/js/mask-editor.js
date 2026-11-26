/* Corrección de máscaras (herramienta local): pincel por pie, goma, deshacer,
   opacidad y guardado. La máscara es una matriz de etiquetas 320 × 240
   (0 fondo, 1 pie a la izquierda de la imagen, 2 a la derecha) que viaja
   comprimida en RLE «valor:cantidad,…». */
(function () {
  'use strict';
  const root = document.querySelector('[data-mask-editor]');
  if (!root) return;
  const $ = (s) => root.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];
  const key = root.dataset.key;
  const csrf = root.dataset.csrf;
  const canvas = $('[data-overlay]');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const cursor = $('[data-cursor]');
  const status = $('[data-status]');
  const undoBtn = $('[data-undo]');
  const toggleBtn = $('[data-toggle]');

  // Colores por etiqueta (contorno opaco + relleno translúcido).
  const COLORS = { 1: [34, 211, 238], 2: [232, 121, 249] };
  let labels = new Uint8Array(W * H);
  let sources = {};
  let origen = null;
  let tool = 1;
  let size = 6;
  let alpha = 0.35;
  let visible = true;
  let dirty = false;
  const undo = [];

  const decode = (rle) => {
    const out = new Uint8Array(W * H);
    let i = 0;
    for (const part of rle.split(',')) {
      const [v, n] = part.split(':').map(Number);
      out.fill(v, i, i + n);
      i += n;
    }
    return out;
  };
  const encode = (arr) => {
    const out = [];
    let v = arr[0];
    let n = 0;
    for (let i = 0; i < arr.length; i += 1) {
      if (arr[i] === v) n += 1;
      else {
        out.push(`${v}:${n}`);
        v = arr[i];
        n = 1;
      }
    }
    out.push(`${v}:${n}`);
    return out.join(',');
  };

  const img = ctx.createImageData(W, H);
  function draw() {
    const d = img.data;
    const fill = Math.round(alpha * 255);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = y * W + x;
        const v = labels[i];
        const o = i * 4;
        if (!v || !visible) {
          d[o + 3] = 0;
          continue;
        }
        const edge =
          x === 0 ||
          y === 0 ||
          x === W - 1 ||
          y === H - 1 ||
          labels[i - 1] !== v ||
          labels[i + 1] !== v ||
          labels[i - W] !== v ||
          labels[i + W] !== v;
        const c = COLORS[v];
        d[o] = c[0];
        d[o + 1] = c[1];
        d[o + 2] = c[2];
        d[o + 3] = edge ? 255 : fill;
      }
    }
    ctx.putImageData(img, 0, 0);
    for (const k of [1, 2]) {
      let n = 0;
      for (const v of labels) if (v === k) n += 1;
      const el = $(`[data-count="${k}"]`);
      if (el) el.textContent = `${n.toLocaleString('es-AR')} px`;
    }
  }

  function setStatus(text, tone) {
    status.textContent = text;
    status.dataset.tone = tone || '';
  }

  function markDirty() {
    if (!dirty) setStatus('Cambios sin guardar.', 'warn');
    dirty = true;
  }

  function pushUndo() {
    undo.push(labels.slice());
    if (undo.length > 40) undo.shift();
    undoBtn.disabled = false;
  }

  function doUndo() {
    if (!undo.length) return;
    labels = undo.pop();
    undoBtn.disabled = !undo.length;
    markDirty();
    draw();
  }

  /* ---------- Pintado ---------- */
  const scale = () => canvas.getBoundingClientRect().width / W;
  function toImage(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H };
  }
  function stamp(cx, cy) {
    const r = size / 2;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(W - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(H - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) labels[y * W + x] = tool;
      }
    }
  }
  let painting = false;
  let last = null;
  function line(a, b) {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(0.5, size / 4)));
    for (let s = 0; s <= steps; s += 1) stamp(a.x + ((b.x - a.x) * s) / steps, a.y + ((b.y - a.y) * s) / steps);
  }
  function moveCursor(ev) {
    const r = canvas.getBoundingClientRect();
    const d = size * scale();
    cursor.style.width = `${d}px`;
    cursor.style.height = `${d}px`;
    cursor.style.transform = `translate(${ev.clientX - r.left - d / 2}px, ${ev.clientY - r.top - d / 2}px)`;
    cursor.dataset.tool = String(tool);
  }
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    canvas.setPointerCapture(ev.pointerId);
    pushUndo();
    painting = true;
    last = toImage(ev);
    stamp(last.x, last.y);
    markDirty();
    draw();
  });
  canvas.addEventListener('pointermove', (ev) => {
    moveCursor(ev);
    if (!painting) return;
    const p = toImage(ev);
    line(last, p);
    last = p;
    draw();
  });
  const stop = () => {
    painting = false;
    last = null;
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerenter', () => cursor.classList.add('is-visible'));
  canvas.addEventListener('pointerleave', () => cursor.classList.remove('is-visible'));

  /* ---------- Controles ---------- */
  const setTool = (v) => {
    tool = Number(v);
    $$('input[name="tool"]').forEach((r) => (r.checked = Number(r.value) === tool));
    cursor.dataset.tool = String(tool);
  };
  $$('input[name="tool"]').forEach((r) => r.addEventListener('change', () => setTool(r.value)));
  const sizeIn = $('[data-size]');
  const setSize = (v) => {
    size = Math.max(1, Math.min(30, Number(v)));
    sizeIn.value = String(size);
    $('[data-size-out]').textContent = String(size);
  };
  sizeIn.addEventListener('input', () => setSize(sizeIn.value));
  const alphaIn = $('[data-alpha]');
  alphaIn.addEventListener('input', () => {
    alpha = Number(alphaIn.value) / 100;
    $('[data-alpha-out]').textContent = alphaIn.value;
    draw();
  });
  const toggle = () => {
    visible = !visible;
    toggleBtn.lastChild.textContent = visible ? 'Ocultar' : 'Mostrar';
    toggleBtn.setAttribute('aria-pressed', String(!visible));
    draw();
  };
  toggleBtn.addEventListener('click', toggle);
  undoBtn.addEventListener('click', doUndo);

  $$('[data-source]').forEach((b) =>
    b.addEventListener('click', () => {
      const s = b.dataset.source;
      if (!sources[s]) return;
      pushUndo();
      labels = decode(sources[s]);
      origen = s;
      $$('[data-source]').forEach((x) => x.classList.toggle('is-active', x === b));
      markDirty();
      draw();
    }),
  );

  document.addEventListener('keydown', (ev) => {
    if (ev.target.closest('input, textarea, select') && ev.target.type !== 'range' && ev.target.type !== 'radio')
      return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      doUndo();
    } else if (ev.key === '1' || ev.key === '2') setTool(ev.key);
    else if (ev.key.toLowerCase() === 'e') setTool(0);
    else if (ev.key === '[') setSize(size - 1);
    else if (ev.key === ']') setSize(size + 1);
    else if (ev.key.toLowerCase() === 'h') toggle();
  });

  /* La imagen de fondo (fusión, paleta, rango, alarma) la maneja el visor de
     termogramas (public/js/thermo-viewer.js); esta capa sólo dibuja la máscara. */

  /* ---------- Guardado ---------- */
  async function save(goNext) {
    const btns = $$('[data-save], [data-save-next]');
    btns.forEach((b) => (b.disabled = true));
    setStatus('Guardando…');
    try {
      const res = await fetch(`/mascaras/${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ rle: encode(labels), origen }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || body.message || 'No se pudo guardar.');
      dirty = false;
      setStatus('Guardada.', 'ok');
      if (goNext && root.dataset.next) window.location.assign(root.dataset.next);
    } catch (err) {
      setStatus(err.message || 'No se pudo guardar.', 'danger');
    } finally {
      btns.forEach((b) => (b.disabled = false));
    }
  }
  $('[data-save]').addEventListener('click', () => save(false));
  const nextBtn = $('[data-save-next]');
  if (nextBtn) nextBtn.addEventListener('click', () => save(true));
  window.addEventListener('beforeunload', (ev) => {
    if (dirty) ev.preventDefault();
  });

  /* ---------- Carga ---------- */
  fetch(`/mascaras/${key}/mascaras.json`, { headers: { Accept: 'application/json' } })
    .then((r) => r.json())
    .then((m) => {
      sources = { corregida: m.corregida, unet: m.unet, clasica: m.clasica };
      origen = m.base;
      if (sources[m.base]) labels = decode(sources[m.base]);
      draw();
    })
    .catch(() => setStatus('No se pudo cargar la máscara.', 'danger'));
})();
