/* Asistente del nuevo estudio: pasos, validación por paso, indicadores de
   condiciones ambientales, carga de las dos termografías con vista previa
   (JPG/PNG en el navegador; IS2 generado por el servidor) y reutilización de
   una toma 1 anterior. */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const num = (v) => Number(String(v).replace(',', '.'));
  const fmtBytes = (n) =>
    n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1).replace('.', ',')} MB`;
  const ALLOWED = ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'is2'];

  document.addEventListener('DOMContentLoaded', () => {
    const form = $('[data-wizard]');
    if (!form) return;
    const csrf = $('input[name="_csrf"]', form)?.value;

    const panels = $$('[data-step]', form);
    const indicators = $$('[data-step-indicator]', form);
    let current = 0;

    const firstError = panels.findIndex((p) => p.querySelector('.has-error, .field__error:not([hidden])'));
    if (firstError > 0) current = firstError;

    function show(i, { focus = true } = {}) {
      current = Math.max(0, Math.min(panels.length - 1, i));
      panels.forEach((p, idx) => p.classList.toggle('is-active', idx === current));
      indicators.forEach((li, idx) => {
        li.classList.toggle('is-done', idx < current);
        if (idx === current) li.setAttribute('aria-current', 'step');
        else li.removeAttribute('aria-current');
      });
      const bar = $('[data-progress]', form);
      if (bar) bar.style.setProperty('--progress', `${((current + 1) / panels.length) * 100}%`);
      if (current === panels.length - 1) fillSummary();
      if (focus) {
        const heading = panels[current].querySelector('h2');
        if (heading) {
          heading.setAttribute('tabindex', '-1');
          heading.focus({ preventScroll: true });
        }
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    function validatePanel(panel) {
      const fields = $$('input, select, textarea', panel).filter(
        (el) => !el.disabled && el.type !== 'hidden' && el.type !== 'file' && !el.closest('[hidden]'),
      );
      for (const el of fields) {
        if (!el.checkValidity()) {
          el.reportValidity();
          return false;
        }
      }
      if (panel.dataset.step === '2') {
        if (reuseMode() && !$('[data-toma1-select]', form).value) {
          $('[data-toma1-select]', form).focus();
          return false;
        }
        const missing = $$('[data-dropzone]', panel).find((dz) => !dz.hidden && !dz.classList.contains('has-file'));
        if (missing) {
          showFileError(missing, 'Cargá esta termografía para continuar.');
          missing.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return false;
        }
      }
      return true;
    }

    $$('[data-next]', form).forEach((b) =>
      b.addEventListener('click', () => {
        if (validatePanel(panels[current])) show(current + 1);
      }),
    );
    $$('[data-prev]', form).forEach((b) => b.addEventListener('click', () => show(current - 1)));
    indicators.forEach((li, idx) =>
      li.addEventListener('click', () => {
        if (idx < current) show(idx);
      }),
    );

    form.addEventListener('submit', (e) => {
      for (let i = 0; i < panels.length; i += 1) {
        if (!validatePanel(panels[i])) {
          e.preventDefault();
          show(i);
          return;
        }
      }
      const btn = $('[data-submit]', form);
      if (btn) {
        btn.setAttribute('aria-disabled', 'true');
        btn.classList.add('is-loading');
        const label = btn.querySelector('span');
        if (label) label.textContent = 'Analizando…';
      }
    });

    /* ---------- Paciente → centro y tomas 1 reutilizables ---------- */
    const patient = $('[data-patient-select]', form);
    const sourceBox = $('[data-toma1-source]', form);
    const reuseBox = $('[data-toma1-reuse]', form);
    const reuseSelect = $('[data-toma1-select]', form);
    const dz1 = $('[data-dropzone][data-slot="toma1"]', form);
    const fechaToma1Box = $('[data-fecha-toma1]', form);
    const reuseMode = () => $('[data-toma1-mode][value="reusar"]', form)?.checked && !sourceBox.hidden;

    function syncToma1Mode() {
      const reuse = reuseMode();
      if (reuseBox) reuseBox.hidden = !reuse;
      if (dz1) {
        dz1.hidden = reuse;
        $('input[type="file"]', dz1).required = !reuse;
      }
      if (reuseSelect) {
        reuseSelect.required = reuse;
        if (!reuse) reuseSelect.value = '';
      }
      if (fechaToma1Box) {
        const input = $('input', fechaToma1Box);
        input.required = !reuse;
        input.disabled = reuse;
        fechaToma1Box.classList.toggle('is-muted', reuse);
      }
    }

    function syncPatient() {
      const opt = patient?.selectedOptions[0];
      let options;
      try {
        options = JSON.parse(opt?.dataset.toma1 || '[]');
      } catch {
        options = [];
      }
      if (sourceBox) sourceBox.hidden = !options.length;
      if (reuseSelect) {
        reuseSelect.innerHTML = '<option value="">Elegí una toma</option>';
        options.forEach((o) => {
          const el = document.createElement('option');
          el.value = o.id;
          el.textContent = `Toma 1 del ${o.fecha}`;
          reuseSelect.appendChild(el);
        });
      }
      if (!options.length) {
        const up = $('[data-toma1-mode][value="subir"]', form);
        if (up) up.checked = true;
      }
      const centro = $('[data-centro]', form);
      if (centro && opt?.dataset.centro) centro.value = opt.dataset.centro;
      syncToma1Mode();
    }
    patient?.addEventListener('change', syncPatient);
    $$('[data-toma1-mode]', form).forEach((r) => r.addEventListener('change', syncToma1Mode));
    syncPatient();

    /* ---------- Condiciones ambientales ---------- */
    $$('[data-env]', form).forEach((card) => {
      const input = $('input', card);
      const badge = $('[data-env-badge]', card);
      const min = Number(card.dataset.min);
      const max = Number(card.dataset.max);
      const sync = () => {
        const raw = input.value.trim();
        card.classList.remove('is-ok', 'is-warn');
        if (!raw || Number.isNaN(num(raw))) {
          badge.textContent = '';
          return;
        }
        const ok = num(raw) >= min && num(raw) <= max;
        card.classList.add(ok ? 'is-ok' : 'is-warn');
        badge.textContent = ok ? 'Dentro del protocolo' : 'Fuera de rango';
      };
      input.addEventListener('input', sync);
      sync();
    });

    /* ---------- Calidad de imagen ---------- */
    const motivo = $('[data-motivo]', form);
    const syncValida = () => {
      const invalid = $('[data-valida][value="no"]', form)?.checked;
      if (motivo) {
        motivo.hidden = !invalid;
        const input = $('input', motivo);
        if (input) input.required = Boolean(invalid);
      }
    };
    $$('[data-valida]', form).forEach((r) => r.addEventListener('change', syncValida));
    syncValida();

    /* ---------- Carga de imágenes ---------- */
    function showFileError(dz, msg) {
      const err = $('[data-dz-error]', dz);
      dz.classList.toggle('has-error', Boolean(msg));
      if (err) {
        err.textContent = msg || '';
        err.hidden = !msg;
      }
    }

    function setPreviewState(dz, state, text) {
      const img = $('[data-dz-img]', dz);
      const fileBox = $('[data-dz-file]', dz);
      const loading = $('[data-dz-loading]', dz);
      img.hidden = state !== 'img';
      fileBox.hidden = state !== 'file';
      loading.hidden = state !== 'loading';
      if (state === 'file') $('[data-dz-ext]', dz).textContent = text || 'Sin vista previa';
    }

    async function is2Preview(dz, file) {
      setPreviewState(dz, 'loading');
      try {
        const body = new FormData();
        body.append('archivo', file);
        const res = await fetch('/medico/estudios/vista-previa', {
          method: 'POST',
          body,
          headers: { 'X-CSRF-Token': csrf },
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        showImage(dz, URL.createObjectURL(blob));
      } catch {
        setPreviewState(dz, 'file', 'IS2 (no se pudo generar la vista previa)');
      }
    }

    function showImage(dz, url) {
      const img = $('[data-dz-img]', dz);
      if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
      img.dataset.url = url;
      img.onload = () => setPreviewState(dz, 'img');
      img.onerror = () => setPreviewState(dz, 'file', 'Formato sin vista previa');
      img.src = url;
    }

    function renderFile(dz, file) {
      const input = $('input[type="file"]', dz);
      const maxMb = Number(input.dataset.maxMb || 4);
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (!ALLOWED.includes(ext)) {
        showFileError(dz, 'Formato no admitido. Usá JPG, PNG, TIFF o IS2.');
        input.value = '';
        dz.classList.remove('has-file');
        return;
      }
      if (file.size > maxMb * 1048576) {
        showFileError(dz, `El archivo supera los ${maxMb} MB.`);
        input.value = '';
        dz.classList.remove('has-file');
        return;
      }
      showFileError(dz, '');
      dz.classList.add('has-file');
      $('[data-dz-empty]', dz).hidden = true;
      $('[data-dz-preview]', dz).hidden = false;
      $('[data-dz-name]', dz).textContent = file.name;
      $('[data-dz-size]', dz).textContent = fmtBytes(file.size);
      if (ext === 'is2') is2Preview(dz, file);
      else if (ext === 'tif' || ext === 'tiff') setPreviewState(dz, 'file', 'TIFF (sin vista previa en el navegador)');
      else showImage(dz, URL.createObjectURL(file));
    }

    $$('[data-dropzone]', form).forEach((dz) => {
      const input = $('input[type="file"]', dz);
      input.addEventListener('change', () => {
        if (input.files && input.files[0]) renderFile(dz, input.files[0]);
      });
      ['dragenter', 'dragover'].forEach((ev) =>
        dz.addEventListener(ev, (e) => {
          e.preventDefault();
          dz.classList.add('is-over');
        }),
      );
      ['dragleave', 'drop'].forEach((ev) =>
        dz.addEventListener(ev, (e) => {
          e.preventDefault();
          dz.classList.remove('is-over');
        }),
      );
      dz.addEventListener('drop', (e) => {
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
        } catch {
          /* navegadores sin DataTransfer: se usa el selector */
        }
        renderFile(dz, file);
      });
    });

    /* ---------- Resumen ---------- */
    function fillSummary() {
      const set = (k, v) => {
        const el = $(`[data-sum="${k}"]`, form);
        if (el) el.textContent = v || '—';
      };
      set('patientId', patient?.selectedOptions[0]?.textContent.trim());
      const reuse = reuseMode();
      const f1 = $('#fechaToma1', form)?.value;
      set(
        'toma1',
        reuse
          ? reuseSelect.selectedOptions[0]?.textContent
          : `${f1 ? new Date(`${f1}T12:00:00`).toLocaleDateString('es-AR') : '—'} · ${$('[data-dropzone][data-slot="toma1"] [data-dz-name]', form)?.textContent || 'sin archivo'}`,
      );
      const fh = $('#fechaHora', form)?.value;
      set(
        'fechaHora',
        `${fh ? new Date(fh).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—'} · ${$('[data-dropzone][data-slot="toma2"] [data-dz-name]', form)?.textContent || 'sin archivo'}`,
      );
      const t = $('#tempAmbiente', form)?.value;
      const h = $('#humedadRelativa', form)?.value;
      const tCard = $('[data-env="temp"]', form);
      const hCard = $('[data-env="hum"]', form);
      set('tempAmbiente', t ? `${t} °C${tCard?.classList.contains('is-warn') ? ' (fuera de rango)' : ''}` : '');
      set('humedadRelativa', h ? `${h} %${hCard?.classList.contains('is-warn') ? ' (fuera de rango)' : ''}` : '');
      const thumbs = $('[data-summary-thumbs]', form);
      if (thumbs) {
        thumbs.innerHTML = '';
        $$('[data-dropzone]', form).forEach((dz) => {
          if (dz.hidden) return;
          const img = $('[data-dz-img]', dz);
          const fig = document.createElement('figure');
          const cap = document.createElement('figcaption');
          cap.textContent = $('.dropzone__badge', dz)?.textContent || '';
          if (img && !img.hidden && img.src) {
            const clone = document.createElement('img');
            clone.src = img.src;
            clone.alt = img.alt;
            fig.appendChild(clone);
          }
          fig.appendChild(cap);
          thumbs.appendChild(fig);
        });
      }
    }

    show(current, { focus: false });
  });
})();
