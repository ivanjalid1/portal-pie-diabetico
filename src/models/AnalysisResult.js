'use strict';

const { CAMBIO_SIGNIFICATIVO } = require('../config/domain');

const ROI_ORDER = ['dedo_mayor', 'dedos_menores', 'metatarso', 'arco_interno', 'arco_externo', 'talon', 'general'];

function mapRois(list) {
  return (list || [])
    .map((r) => ({
      roi: r.roi,
      avgDer: Number(r.avgDer),
      avgIzq: Number(r.avgIzq),
      maxDer: Number(r.maxDer),
      maxIzq: Number(r.maxIzq),
      minDer: Number(r.minDer),
      minIzq: Number(r.minIzq),
      deltaT: Number(r.deltaT),
    }))
    .sort((a, b) => ROI_ORDER.indexOf(a.roi) - ROI_ORDER.indexOf(b.roi));
}

/**
 * Resultado del análisis comparativo toma 1 vs toma 2, producido por una
 * estrategia `UlcerPredictor`. Guarda las temperaturas absolutas por ROI de
 * cada toma, el umbral de asimetría usado, la clasificación térmica de cada
 * toma y la probabilidad estimada (que considera la evolución).
 *
 * Los campos sin sufijo (`rois`, `grupo`, `deltaTMax`, ...) corresponden a la
 * toma 2 (la más reciente); los de sufijo `Toma1`, a la toma basal.
 */
class AnalysisResult {
  constructor(a) {
    this.id = a.id;
    this.studyId = a.studyId;
    this.predictorVersion = a.predictorVersion;
    this.fuenteRois = a.fuenteRois || 'simulada';
    this.rois = mapRois(a.rois);
    this.roisToma1 = mapRois(a.roisToma1);
    this.deltaTMax = Number(a.deltaTMax);
    this.deltaTMaxRoi = a.deltaTMaxRoi;
    this.deltaTMaxToma1 = a.deltaTMaxToma1 === null || a.deltaTMaxToma1 === undefined ? null : Number(a.deltaTMaxToma1);
    this.deltaTMaxRoiToma1 = a.deltaTMaxRoiToma1 || null;
    this.umbral = Number(a.umbral ?? 1);
    this.grupo = a.grupo || null;
    this.simetrico = a.simetrico === undefined ? null : a.simetrico;
    this.grupoToma1 = a.grupoToma1 || null;
    this.simetricoToma1 = a.simetricoToma1 === undefined ? null : a.simetricoToma1;
    this.probabilidad = Number(a.probabilidad);
    this.categoria = a.categoria;
    this.horizonteSemanas = Number(a.horizonteSemanas);
    this.factores = Array.isArray(a.factores) ? a.factores : [];
    this.simulado = a.simulado !== false;
    this.createdAt = a.createdAt || new Date().toISOString();
  }

  roi(key, toma = 2) {
    return (toma === 1 ? this.roisToma1 : this.rois).find((r) => r.roi === key) || null;
  }

  /** ROIs de la toma 2 cuya asimetría supera el umbral. */
  get roisSobreUmbral() {
    return this.rois.filter((r) => r.roi !== 'general' && Math.abs(r.deltaT) >= this.umbral);
  }

  get tieneToma1() {
    return this.roisToma1.length > 0;
  }

  /**
   * Evolución por ROI: ΔT en cada toma y cambio de la asimetría
   * (|ΔT₂| − |ΔT₁|). Positivo = la asimetría aumentó.
   */
  get evolucion() {
    if (!this.tieneToma1) return [];
    return this.rois.map((r2) => {
      const r1 = this.roi(r2.roi, 1);
      const dt1 = r1 ? r1.deltaT : null;
      const cambio = r1 ? Math.round((Math.abs(r2.deltaT) - Math.abs(dt1)) * 100) / 100 : null;
      let tendencia = 'estable';
      if (cambio !== null && cambio >= CAMBIO_SIGNIFICATIVO) tendencia = 'empeora';
      else if (cambio !== null && cambio <= -CAMBIO_SIGNIFICATIVO) tendencia = 'mejora';
      return { roi: r2.roi, dt1, dt2: r2.deltaT, cambio, tendencia };
    });
  }

  /** ROIs (sin la general) en las que la asimetría empeoró entre tomas. */
  get roisQueEmpeoran() {
    return this.evolucion.filter((e) => e.roi !== 'general' && e.tendencia === 'empeora');
  }

  /** Mayor aumento de asimetría entre tomas (°C, ≥ 0). */
  get maxEmpeoramiento() {
    const vals = this.evolucion.filter((e) => e.roi !== 'general' && e.cambio !== null).map((e) => e.cambio);
    return vals.length ? Math.max(0, ...vals) : 0;
  }
}

AnalysisResult.ROI_ORDER = ROI_ORDER;

module.exports = AnalysisResult;
