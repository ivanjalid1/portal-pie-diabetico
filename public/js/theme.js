/* Tema claro por defecto; el oscuro sólo si el usuario lo eligió con el botón.
   Se carga de forma bloqueante en <head> para evitar el parpadeo. */
(function () {
  'use strict';
  const KEY = 'termopie-theme';
  const root = document.documentElement;
  function read() {
    try {
      return localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }
  function apply(theme) {
    if (theme === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0c141b' : '#f5f8fb');
  }
  apply(read());

  document.addEventListener('click', function (e) {
    const btn = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (!btn) return;
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    apply(next);
    try {
      localStorage.setItem(KEY, next);
    } catch (err) {
      /* almacenamiento no disponible: el cambio dura hasta recargar */
    }
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(next === 'dark'));
      b.setAttribute('aria-label', next === 'dark' ? 'Usar tema claro' : 'Usar tema oscuro');
    });
  });
})();
