/* Revisión manual de las fotos (página /revision, mejora progresiva).
 * Sin JS cada foto es un formulario normal (POST + vuelta a la página). Con JS:
 *  - elegir Aprobado / Rechazado / Falta revisar guarda al instante;
 *  - «Guardar» (o Ctrl+Enter en el comentario) guarda el comentario;
 *  - se actualizan la etiqueta, el «Guardado por…» y el progreso sin recargar;
 *  - atajos: A/R/P (estado y pasa a la siguiente), J/K (siguiente/anterior),
 *    V (foto visible), C (comentario). */
(() => {
  'use strict';

  const root = document.querySelector('[data-rv]');
  const TONO = { aprobado: 'ok', rechazado: 'danger', pendiente: 'muted' };
  const ESTADOS = Object.keys(TONO);
  const KEY_ESTADO = { a: 'aprobado', r: 'rechazado', p: 'pendiente' };
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  /* ---------- Progreso ---------- */
  const num = (el) => Number((el && el.textContent) || 0);
  function bump(estado, d) {
    const n = $(`[data-rv-n="${estado}"]`);
    const c = $(`[data-rv-c="${estado}"]`);
    if (n) n.textContent = String(num(n) + d);
    if (c) c.textContent = String(num(c) + d);
  }
  function refreshProgress() {
    const total = num($('[data-rv-total]'));
    const ok = num($('[data-rv-n="aprobado"]'));
    const bad = num($('[data-rv-n="rechazado"]'));
    const rev = $('[data-rv-revisadas]');
    if (rev) rev.textContent = String(ok + bad);
    const pct = $('[data-rv-pct]');
    if (pct) pct.textContent = String(total ? Math.round(((ok + bad) / total) * 100) : 0);
    const bar = $('[data-rv-bar]');
    if (bar) bar.setAttribute('aria-valuenow', String(ok + bad));
    const bOk = $('[data-rv-bar-ok]');
    const bBad = $('[data-rv-bar-bad]');
    if (bOk) bOk.style.width = `${total ? (ok / total) * 100 : 0}%`;
    if (bBad) bBad.style.width = `${total ? (bad / total) * 100 : 0}%`;
  }

  /* ---------- Guardar ---------- */
  function setEstado(form, estado, etiqueta) {
    const tile = form.closest('[data-rv-tile]');
    if (tile) ESTADOS.forEach((e) => tile.classList.toggle(`rv-tile--${e}`, e === estado));
    const badge = $('[data-ir-badge]', form);
    if (badge) {
      badge.classList.remove('badge--ok', 'badge--danger', 'badge--muted');
      badge.classList.add(`badge--${TONO[estado]}`);
      if (etiqueta) badge.textContent = etiqueta;
    }
    const prev = form.dataset.estado;
    if (prev && prev !== estado) {
      bump(prev, -1);
      bump(estado, 1);
      refreshProgress();
    }
    form.dataset.estado = estado;
  }

  function bind(form) {
    const saved = $('[data-ir-saved]', form);
    const btn = $('[data-ir-save]', form);
    const comment = $('textarea', form);
    let busy = false;
    let again = false;

    async function save() {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      if (btn) btn.disabled = true;
      if (saved) saved.textContent = 'Guardando…';
      try {
        const res = await fetch(form.action, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(new FormData(form)),
          credentials: 'same-origin',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar la revisión.');
        setEstado(form, data.revision.estado, data.revision.etiqueta);
        if (saved) saved.textContent = data.revision.guardado;
        form.classList.remove('is-dirty', 'is-error');
      } catch (err) {
        if (saved) saved.textContent = err.message || 'No se pudo guardar la revisión.';
        form.classList.add('is-error');
      } finally {
        busy = false;
        if (btn) btn.disabled = false;
        if (again) {
          again = false;
          save();
        }
      }
    }
    form.rvSave = save;

    form.addEventListener('change', (ev) => {
      if (ev.target.name === 'estado') save();
    });
    if (comment) {
      comment.addEventListener('input', () => {
        form.classList.add('is-dirty');
        if (saved) saved.textContent = 'Comentario sin guardar';
      });
      comment.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          save();
        }
        if (ev.key === 'Escape') comment.blur();
      });
    }
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      save();
    });
  }

  if (!root) return;
  const tiles = $$('[data-rv-tile]', root);
  tiles.forEach((t) => bind($('[data-ir-form]', t)));

  /* ---------- Foto visible ---------- */
  const visToggle = $('[data-rv-visible]');
  function showVisible(on) {
    tiles.forEach((t) => {
      const vis = $('[data-rv-vis]', t);
      const ir = $('[data-rv-ir]', t);
      if (!vis || !ir) return;
      if (on && !vis.getAttribute('src')) {
        vis.loading = 'lazy';
        vis.src = vis.dataset.src;
      }
      vis.hidden = !on;
      ir.hidden = on;
    });
    try {
      localStorage.setItem('rv-visible', on ? '1' : '0');
    } catch {
      /* sin almacenamiento: sólo esta vista */
    }
  }
  if (visToggle) {
    visToggle.addEventListener('change', () => showVisible(visToggle.checked));
    try {
      if (localStorage.getItem('rv-visible') === '1') {
        visToggle.checked = true;
        showVisible(true);
      }
    } catch {
      /* sin almacenamiento */
    }
  }

  /* ---------- Foto actual y atajos ---------- */
  let current = null;
  function focusTile(t, { scroll = true } = {}) {
    if (!t) return;
    if (current) current.classList.remove('is-current');
    current = t;
    t.classList.add('is-current');
    if (scroll) t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    t.focus({ preventScroll: true });
  }
  root.addEventListener('focusin', (ev) => {
    const t = ev.target.closest('[data-rv-tile]');
    if (t && t !== current) {
      if (current) current.classList.remove('is-current');
      current = t;
      t.classList.add('is-current');
    }
  });
  const step = (d, { page = true } = {}) => {
    const i = current ? tiles.indexOf(current) : -1;
    const n = tiles[i + d];
    if (n) focusTile(n);
    else if (d > 0 && page) {
      // «Falta revisar»: al recargar, las ya revisadas salen y entran las siguientes.
      const next = root.dataset.rvFiltro === 'pendiente' ? null : $('[data-rv-next-page]');
      window.location.href = next ? next.href : window.location.pathname + window.location.search;
    }
  };

  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'select' || (tag === 'input' && !['radio', 'checkbox'].includes(ev.target.type)))
      return;
    const k = ev.key.toLowerCase();
    if (k === 'j' || k === 'k') {
      ev.preventDefault();
      if (!current) focusTile(tiles[0]);
      else step(k === 'j' ? 1 : -1);
      return;
    }
    if (k === 'v' && visToggle) {
      ev.preventDefault();
      visToggle.checked = !visToggle.checked;
      showVisible(visToggle.checked);
      return;
    }
    if (!current) return;
    const form = $('[data-ir-form]', current);
    if (k === 'c') {
      ev.preventDefault();
      $('textarea', form).focus();
      return;
    }
    const estado = KEY_ESTADO[k];
    if (!estado) return;
    ev.preventDefault();
    const radio = $(`input[name="estado"][value="${estado}"]`, form);
    if (!radio.checked) {
      radio.checked = true;
      form.rvSave();
    }
    step(1, { page: false });
  });

  // Vuelta desde un guardado sin JS (#foto-…): marca esa foto.
  if (location.hash) {
    const t = document.getElementById(location.hash.slice(1));
    if (t && t.matches('[data-rv-tile]')) focusTile(t, { scroll: false });
  }
})();
