/* Botón de impresión del informe (sin scripts en línea por la CSP). */
document.addEventListener('DOMContentLoaded', () => {
  document.querySelector('[data-print]')?.addEventListener('click', () => window.print());
});
