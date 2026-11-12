/* Asistente del nuevo estudio: pasos, validación por paso, indicadores de
   condiciones ambientales y carga de imágenes con vista previa y arrastrar. */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const num = (v) => Number(String(v).replace(',', '.'));
  const fmtBytes = (n) =>
    n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1).replace('.', ',')} MB`;

  document.addEventListener('DOMContentLoaded', () => {
    const form = $('[data-wizard]');
    if (!form) return;

    const panels = $$('[data-step]', form);
    const indicators = $$('[data-step-indicator]', form);
    let current = 0;

    // Si el servidor devolvió errores, abrir el primer paso con error.
    const firstError = panels.findIndex((p) => p.querySelector('.has-error, .field__error:not([hidden])'));
    if (firstError > 0) current = firstError;

    function show(i) {
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
      const heading = panels[current].querySelector('h2');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function validatePanel(panel) {
      const fields = $$('input, select, textarea', panel).filter((el) => !el.disabled && el.type !== 'hidden');
      for (const el of fields) {
        if (!el.checkValidity()) {
          el.reportValidity();
          return false;
        }
      }
      if (panel.dataset.step === '2') {
        const missing = $$('[data-dropzone]', panel).find((dz) => !dz.classList.contains('has-file'));
        if (missing) {
          showFileError(missing, 'Cargá esta imagen para continuar.');
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
        btn.lastChild.textContent = 'Analizando…';
      }
    });

    /* ---------- Paciente → toma y centro sugeridos ---------- */
    const patient = $('[data-patient-select]', form);
    patient?.addEventListener('change', () => {
      const opt = patient.selectedOptions[0];
      if (!opt || !opt.value) return;
      const toma = Number(opt.dataset.estudios) > 0 ? '2' : '1';
      const radio = $(`[data-toma][value="${toma}"]`, form);
      if (radio) radio.checked = true;
      const centro = $('[data-centro]', form);
      if (centro && opt.dataset.centro) centro.value = opt.dataset.centro;
    });

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

    function renderFile(dz, file) {
      const input = $('input[type="file"]', dz);
      const maxMb = Number(input.dataset.maxMb || 4);
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const allowed = ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'is2'];
      if (!allowed.includes(ext)) {
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
      const img = $('[data-dz-img]', dz);
      const fileBox = $('[data-dz-file]', dz);
      if (['jpg', 'jpeg', 'png'].includes(ext)) {
        if (img.src) URL.revokeObjectURL(img.src);
        img.src = URL.createObjectURL(file);
        img.hidden = false;
        fileBox.hidden = true;
      } else {
        img.hidden = true;
        fileBox.hidden = false;
        $('[data-dz-ext]', dz).textContent =
          ext === 'is2' ? 'Archivo Fluke IS2 (sin vista previa)' : 'TIFF (sin vista previa)';
      }
    }

    $$('[data-dropzone]', form).forEach((dz) => {
      const input = $('input[type="file"]', dz);
      input.addEventListener('change', () => {
        if (input.files[0]) renderFile(dz, input.files[0]);
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
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
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
      const toma = $('[data-toma]:checked', form);
      set('toma', toma?.closest('label')?.textContent.trim());
      const fh = $('#fechaHora', form)?.value;
      set('fechaHora', fh ? new Date(fh).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '');
      const t = $('#tempAmbiente', form)?.value;
      const h = $('#humedadRelativa', form)?.value;
      const tCard = $('[data-env="temp"]', form);
      const hCard = $('[data-env="hum"]', form);
      set('tempAmbiente', t ? `${t} °C${tCard?.classList.contains('is-warn') ? ' (fuera de rango)' : ''}` : '');
      set('humedadRelativa', h ? `${h} %${hCard?.classList.contains('is-warn') ? ' (fuera de rango)' : ''}` : '');
      const files = $$('input[type="file"]', form)
        .map((i) => i.files[0]?.name)
        .filter(Boolean);
      set('images', files.join(' + '));
    }

    show(current);
  });
})();
