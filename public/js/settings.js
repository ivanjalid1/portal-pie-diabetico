/* Configuración: cambios sin guardar, valores sugeridos, restablecer,
   vista previa en vivo y modal de confirmación del recálculo. */
(function () {
  'use strict';
  const form = document.querySelector('[data-settings-form]');
  if (!form) return;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const savebar = $('[data-savebar]');
  const csrf = form.querySelector('input[name="_csrf"]').value;

  const snapshot = () => {
    const out = {};
    for (const [k, v] of new FormData(form).entries()) if (k !== '_csrf') out[k] = String(v).trim();
    return out;
  };
  const norm = (v) =>
    String(v ?? '')
      .replace(',', '.')
      .trim();
  let initial = snapshot();

  function fieldValue(key) {
    const radios = form.querySelectorAll(`input[type="radio"][name="${key}"]`);
    if (radios.length) return [...radios].find((r) => r.checked)?.value || '';
    return form.elements[key]?.value ?? '';
  }

  function setValue(key, value) {
    const radios = form.querySelectorAll(`input[type="radio"][name="${key}"]`);
    if (radios.length) radios.forEach((r) => (r.checked = r.value === value));
    else if (form.elements[key]) form.elements[key].value = value;
    update();
  }

  function refreshField(field) {
    const key = field.dataset.field;
    const value = fieldValue(key);
    const reset = $('[data-reset]', field);
    if (reset) reset.hidden = norm(value) === norm(field.dataset.default);
    const chips = $$('[data-preset]', field);
    if (chips.length) {
      let matched = false;
      chips.forEach((c) => {
        const on = norm(c.dataset.value) === norm(value);
        matched = matched || on;
        c.classList.toggle('is-active', on);
        c.setAttribute('aria-pressed', String(on));
      });
      const custom = $('[data-custom]', field);
      if (custom) custom.classList.toggle('is-active', !matched);
    }
    field.classList.toggle('is-changed', norm(value) !== norm(initial[key]));
  }

  let timer = null;
  function update() {
    $$('[data-field]', form).forEach(refreshField);
    const now = snapshot();
    const dirty = Object.keys(now).filter((k) => norm(now[k]) !== norm(initial[k])).length;
    savebar.hidden = dirty === 0;
    document.body.classList.toggle('has-savebar', dirty > 0);
    $('[data-dirty-count]', savebar).textContent = String(dirty);
    const modalDirty = $('[data-modal-dirty]');
    if (modalDirty) modalDirty.hidden = dirty === 0;
    clearTimeout(timer);
    timer = setTimeout(preview, 250);
  }

  async function preview() {
    try {
      const res = await fetch('/configuracion/vista-previa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify(snapshot()),
        credentials: 'same-origin',
      });
      if (!res.ok) return;
      const p = await res.json();
      $$('[data-pv]').forEach((el) => (el.textContent = String(p[el.dataset.pv] ?? '')));
      $$('[data-pv-bar]').forEach((el) => {
        el.style.width = `${p.total ? Math.round((p[el.dataset.pvBar] / p.total) * 100) : 0}%`;
      });
      $$('[data-pv-riesgo]').forEach((el) => (el.textContent = String(p.riesgo[el.dataset.pvRiesgo])));
      $$('[data-pv-seg]').forEach((el) => (el.style.flexGrow = String(p.riesgo[el.dataset.pvSeg])));
    } catch {
      /* La vista previa es opcional. */
    }
  }

  form.addEventListener('input', update);
  form.addEventListener('change', update);
  form.addEventListener('click', (e) => {
    const preset = e.target.closest('[data-preset]');
    if (preset) setValue(preset.dataset.preset, preset.dataset.value);
    const reset = e.target.closest('[data-reset]');
    if (reset) {
      const field = reset.closest('[data-field]');
      setValue(reset.dataset.reset, field.dataset.default);
      const input = form.elements[reset.dataset.reset];
      if (input && input.focus && !input.length) input.focus();
    }
  });
  $('[data-discard]', form).addEventListener('click', () => {
    Object.entries(initial).forEach(([k, v]) => setValue(k, v));
    update();
  });
  form.addEventListener('submit', () => {
    window.removeEventListener('beforeunload', guard);
  });
  function guard(e) {
    if (!savebar.hidden) {
      e.preventDefault();
      e.returnValue = '';
    }
  }
  window.addEventListener('beforeunload', guard);
  update();
  initial = snapshot();

  /* ---------- Modal propio (sin confirm() nativo) ---------- */
  let lastFocus = null;
  function openModal(modal) {
    lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.classList.add('is-locked');
    const first = modal.querySelector('[data-modal-close].btn, button');
    if (first) first.focus();
  }
  function closeModal(modal) {
    modal.hidden = true;
    document.body.classList.remove('is-locked');
    if (lastFocus) lastFocus.focus();
  }
  $$('[data-modal-open]').forEach((btn) =>
    btn.addEventListener('click', () => openModal(document.getElementById(btn.dataset.modalOpen))),
  );
  $$('.modal').forEach((modal) => {
    $$('[data-modal-close]', modal).forEach((el) => el.addEventListener('click', () => closeModal(modal)));
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal(modal);
      if (e.key !== 'Tab') return;
      const focusables = $$('button, [href], input:not([type="hidden"])', modal).filter((el) => !el.hidden);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
    $('form', modal)?.addEventListener('submit', () => window.removeEventListener('beforeunload', guard));
  });
})();
