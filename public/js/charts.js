/* Gráfico de evolución del paciente (Chart.js 4, cargado desde CDN con versión fija). */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.querySelector('[data-chart="evolucion"]');
    if (!canvas || typeof window.Chart === 'undefined') return;

    const series = JSON.parse(canvas.dataset.series || '[]');
    const umbral = Number(canvas.dataset.umbral || 1);
    const css = getComputedStyle(document.documentElement);
    const token = (name) => css.getPropertyValue(name).trim();

    canvas.closest('[data-chart-box]')?.classList.add('is-ready');
    const Chart = window.Chart;
    Chart.defaults.font.family = token('--font');
    Chart.defaults.color = token('--muted');

    new Chart(canvas, {
      type: 'line',
      data: {
        labels: series.map((s) => s.label),
        datasets: [
          {
            label: 'Probabilidad (%)',
            data: series.map((s) => s.p),
            borderColor: token('--primary'),
            backgroundColor: token('--primary'),
            yAxisID: 'y',
            spanGaps: true,
            tension: 0.25,
            pointRadius: 4,
          },
          {
            label: 'ΔT máx. (°C)',
            data: series.map((s) => s.dt),
            borderColor: '#ec6622',
            backgroundColor: '#ec6622',
            borderDash: [5, 4],
            yAxisID: 'y1',
            tension: 0.25,
            pointRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 400 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 12 } },
          tooltip: {
            callbacks: {
              label: (ctx) =>
                ctx.datasetIndex === 0
                  ? ` Probabilidad: ${ctx.parsed.y.toLocaleString('es-AR')} %`
                  : ` ΔT máx.: ${ctx.parsed.y.toLocaleString('es-AR')} °C (umbral ${umbral.toLocaleString('es-AR')} °C)`,
            },
          },
        },
        scales: {
          y: { min: 0, max: 100, title: { display: true, text: '%' }, grid: { color: token('--line') } },
          y1: {
            min: 0,
            max: 3.5,
            position: 'right',
            title: { display: true, text: '°C' },
            grid: { drawOnChartArea: false },
          },
          x: { grid: { display: false } },
        },
      },
    });
  });
})();
