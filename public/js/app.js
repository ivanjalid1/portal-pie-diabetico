/* Comportamientos comunes: menú móvil, toasts, lightbox, confirmaciones,
   copiar al portapapeles, cuentas demo y pequeños ajustes de formularios. */
(function () {
  'use strict';

  document.documentElement.classList.add('js');

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  document.addEventListener('DOMContentLoaded', () => {
    /* ---------- Menú lateral en móvil ---------- */
    const sidebar = $('#sidebar');
    const openBtn = $('[data-sidebar-open]');
    const setOpen = (open) => {
      if (!sidebar) return;
      sidebar.classList.toggle('is-open', open);
      if (openBtn) openBtn.setAttribute('aria-expanded', String(open));
      if (open) $('.nav__link', sidebar)?.focus();
    };
    openBtn?.addEventListener('click', () => setOpen(true));
    $$('[data-sidebar-close]').forEach((el) => el.addEventListener('click', () => setOpen(false)));

    /* ---------- Toasts ---------- */
    $$('[data-toast]').forEach((toast, i) => {
      const close = () => {
        toast.classList.add('is-leaving');
        setTimeout(() => toast.remove(), 220);
      };
      $('[data-toast-close]', toast)?.addEventListener('click', close);
      if (!toast.classList.contains('toast--error')) setTimeout(close, 5200 + i * 400);
    });

    /* ---------- Lightbox ---------- */
    const lb = $('#lightbox');
    let lastFocus = null;
    const closeLb = () => {
      if (!lb || lb.hidden) return;
      lb.hidden = true;
      lastFocus?.focus();
    };
    $$('[data-lightbox]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!lb) return;
        lastFocus = btn;
        $('img', lb).src = btn.dataset.lightbox;
        $('img', lb).alt = btn.dataset.caption || '';
        $('figcaption', lb).textContent = btn.dataset.caption || '';
        lb.hidden = false;
        $('[data-lightbox-close]', lb).focus();
      });
    });
    lb?.addEventListener('click', (e) => {
      if (e.target === lb || e.target.closest('[data-lightbox-close]')) closeLb();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeLb();
        setOpen(false);
      }
    });

    /* ---------- Confirmaciones ---------- */
    $$('form[data-confirm]').forEach((form) => {
      form.addEventListener('submit', (e) => {
        if (!window.confirm(form.dataset.confirm)) e.preventDefault();
      });
    });

    /* ---------- Evitar doble envío ---------- */
    $$('form').forEach((form) => {
      form.addEventListener('submit', (e) => {
        if (e.defaultPrevented) return;
        const btn = form.querySelector('button[type="submit"]');
        if (btn) {
          setTimeout(() => btn.setAttribute('aria-disabled', 'true'), 0);
        }
      });
    });

    /* ---------- Copiar ---------- */
    $$('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const target = $(btn.dataset.copy);
        if (!target) return;
        try {
          await navigator.clipboard.writeText(target.textContent.trim());
          btn.setAttribute('aria-label', 'Copiado');
          btn.classList.add('is-copied');
          setTimeout(() => btn.classList.remove('is-copied'), 1500);
        } catch {
          /* El navegador no permite el portapapeles: el texto queda seleccionable. */
        }
      });
    });

    /* ---------- Mostrar contraseña ---------- */
    $$('[data-toggle-password]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.togglePassword);
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
      });
    });

    /* ---------- Cuentas demo en el login ---------- */
    $$('[data-fill-login]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const email = $('#email');
        const pass = $('#password');
        if (email && pass) {
          email.value = btn.dataset.email;
          pass.value = btn.dataset.password;
          pass.closest('form')?.querySelector('button[type="submit"]')?.focus();
        }
      });
    });

    /* ---------- Autoenvío de filtros ---------- */
    $$('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form?.submit()));

    /* ---------- Formulario de paciente ---------- */
    const pform = $('[data-patient-form]');
    if (pform) {
      const exclusion = $$('[data-exclusion]', pform);
      const warn = $('[data-exclusion-warning]', pform);
      const submit = $('[data-submit-patient]', pform);
      const syncExclusion = () => {
        const any = exclusion.some((c) => c.checked);
        if (warn) warn.hidden = !any;
        if (submit) submit.toggleAttribute('disabled', any);
      };
      exclusion.forEach((c) => c.addEventListener('change', syncExclusion));
      syncExclusion();

      const centro = $('[data-codigo-source]', pform);
      const codigo = $('[data-codigo-target]', pform);
      centro?.addEventListener('change', () => {
        const opt = centro.selectedOptions[0];
        if (codigo && opt?.dataset.codigo) codigo.value = opt.dataset.codigo;
      });

      const score = $('[data-neuro-score]', pform);
      const grade = $('[data-neuro-grade]', pform);
      const gradeOf = (p) =>
        p === '' || Number.isNaN(p) ? '—' : p <= 0 ? 'Normal' : p <= 2 ? 'Leve' : p <= 5 ? 'Moderada' : 'Grave';
      const syncGrade = () => {
        if (grade && score) grade.textContent = gradeOf(score.value === '' ? '' : Number(score.value));
      };
      score?.addEventListener('input', syncGrade);
      syncGrade();

      $$('[data-vib-max]', pform).forEach((cb) => {
        const input = $(`[data-vib-input="${cb.dataset.vibMax}"]`, pform);
        const sync = () => {
          if (!input) return;
          input.disabled = cb.checked;
          if (cb.checked) input.value = '';
        };
        cb.addEventListener('change', sync);
        sync();
      });
    }

    /* Mostrar u ocultar campos dependientes de una casilla. */
    $$('[data-toggle-target]').forEach((cb) => {
      const target = $(cb.dataset.toggleTarget);
      const sync = () => {
        if (target) target.hidden = !cb.checked;
      };
      cb.addEventListener('change', sync);
      sync();
    });

    /* ---------- Formulario de desenlace ---------- */
    $$('[data-outcome-form]').forEach((form) => {
      const detail = $('[data-outcome-detail]', form);
      const sync = () => {
        const yes = $('[data-outcome-yes]', form)?.checked;
        if (detail) detail.hidden = !yes;
      };
      $$('input[name="generoLesion"]', form).forEach((r) => r.addEventListener('change', sync));
      sync();
    });
  });
})();
