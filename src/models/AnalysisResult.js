'use strict';

/**
 * Resultado del análisis de un estudio, producido por una estrategia de
 * predicción (`UlcerPredictor`). Guarda las temperaturas absolutas por ROI
 * (no sólo el ΔT), el umbral de asimetría usado y la clasificación térmica.
 */
class AnalysisResult {
  constructor(a) {
    this.id = a.id;
    this.studyId = a.studyId;
    this.predictorVersion = a.predictorVersion;
    this.rois = (a.rois || []).map((r) => ({
      roi: r.roi,
      avgDer: Number(r.avgDer),
      avgIzq: Number(r.avgIzq),
      maxDer: Number(r.maxDer),
      maxIzq: Number(r.maxIzq),
      minDer: Number(r.minDer),
      minIzq: Number(r.minIzq),
      deltaT: Number(r.deltaT),
    }));
    this.deltaTMax = Number(a.deltaTMax);
    this.deltaTMaxRoi = a.deltaTMaxRoi;
    this.umbral = Number(a.umbral ?? 1);
    this.grupo = a.grupo || null;
    this.simetrico = a.simetrico === undefined ? null : a.simetrico;
    this.probabilidad = Number(a.probabilidad);
    this.categoria = a.categoria;
    this.horizonteSemanas = Number(a.horizonteSemanas);
    this.factores = Array.isArray(a.factores) ? a.factores : [];
    this.simulado = a.simulado !== false;
    this.createdAt = a.createdAt || new Date().toISOString();
  }

  roi(key) {
    return this.rois.find((r) => r.roi === key) || null;
  }

  /** ROIs cuya asimetría supera el umbral usado en el análisis. */
  get roisSobreUmbral() {
    return this.rois.filter((r) => r.roi !== 'general' && Math.abs(r.deltaT) >= this.umbral);
  }
}

module.exports = AnalysisResult;
