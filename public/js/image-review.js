/* Revisión manual de las fotos del visor (mejora progresiva).
 * Sin JS cada foto es un formulario normal (POST + redirección). Con JS se
 * guarda sin recargar, se actualizan la etiqueta, el «Guardado por…» y el
 * contador del encabezado, y se resalta la foto que muestra el visor. */
(() => {
  'use strict';

  const TONO = { aprobado: 'ok', rechazado: 'danger', pendiente: 'muted' };
  const ESTADOS = Object.keys(TONO);

  function updateCount(resumen, texto) {
    const count = document.querySelector('[data-ir-count]');
    if (!count) return;
    const tono = resumen.rechazado ? 'danger' : resumen.pendiente ? 'muted' : 'ok';
    count.classList.remove('badge--ok', 'badge--danger', 'badge--muted');
    count.classList.add(`badge--${tono}`);
    const t = count.querySelector('[data-ir-count-text]');
    if (t) t.textContent = texto;
  }

  function setEstado(form, estado, etiqueta) {
    ESTADOS.forEach((e) => form.classList.toggle(`ir-item--${e}`, e === estado));
    const badge = form.querySelector('[data-ir-badge]');
    if (badge) {
      badge.classList.remove('badge--ok', 'badge--danger', 'badge--muted');
      badge.classList.add(`badge--${TONO[estado]}`);
      if (etiqueta) badge.textContent = etiqueta;
    }
  }

  function bind(form) {
    const saved = form.querySelector('[data-ir-saved]');
    const btn = form.querySelector('[data-ir-save]');
    let lastSaved = saved ? saved.textContent : '';

    // Al cambiar algo, el botón invita a guardar.
    form.addEventListener('input', () => {
      form.classList.add('is-dirty');
      if (saved) saved.textContent = 'Sin guardar';
    });

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
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
        lastSaved = data.revision.guardado;
        if (saved) saved.textContent = lastSaved;
        form.classList.remove('is-dirty');
        updateCount(data.resumen, data.resumenTexto);
      } catch (err) {
        if (saved) saved.textContent = err.message || 'No se pudo guardar la revisión.';
        form.classList.add('is-error');
        setTimeout(() => form.classList.remove('is-error'), 2400);
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  document.querySelectorAll('[data-ir]').forEach((box) => {
    const forms = Array.from(box.querySelectorAll('[data-ir-form]'));
    forms.forEach(bind);
    // Resalta la foto que se ve en el visor (evento de thermo-viewer.js).
    const viewer = box.closest('[data-tv]');
    if (!viewer || forms.length < 2) return;
    const mark = (toma, rep) =>
      forms.forEach((f) => {
        const on = Number(f.dataset.toma) === toma && Number(f.dataset.rep) === rep;
        f.classList.toggle('is-live', on);
        const live = f.querySelector('[data-ir-live]');
        if (live) live.hidden = !on;
      });
    viewer.addEventListener('tv:foto', (ev) => mark(ev.detail?.toma, ev.detail?.rep));
    // El visor pudo cargar la primera foto antes de este script.
    const [t0, r0] = String(viewer.dataset.tvFoto || '')
      .split('-')
      .map(Number);
    if (t0) mark(t0, r0);
  });
})();
