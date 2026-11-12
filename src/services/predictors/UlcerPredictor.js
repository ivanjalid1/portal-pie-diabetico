'use strict';

/**
 * Interfaz de la estrategia de predicción (patrón Strategy).
 *
 * Cualquier algoritmo (simulado, regresión logística sobre features térmicas,
 * red convolucional, etc.) implementa `predict()` con el mismo contrato, de modo
 * que el `AnalysisService` no cambia al reemplazar el algoritmo.
 *
 * @typedef {Object} PredictionInput
 * @property {import('../../models/Patient')} patient
 * @property {import('../../models/Study')} study
 * @property {Array<{slot: string, buffer?: Buffer, mime?: string}>} images
 *
 * @typedef {Object} PredictionOutput
 * @property {string} predictorVersion
 * @property {Array<{roi, avgDer, avgIzq, maxDer, maxIzq, minDer, minIzq, deltaT}>} rois
 * @property {number} deltaTMax       Mayor |ΔT| entre las ROIs (°C, con signo).
 * @property {string} deltaTMaxRoi
 * @property {number} probabilidad    Probabilidad de úlcera (0–100 %).
 * @property {string} categoria       'sin_riesgo' | 'moderado' | 'alto'.
 * @property {number} horizonteSemanas
 * @property {Array<{key, nombre, valor, contribucion}>} factores
 * @property {boolean} simulado
 */
class UlcerPredictor {
  /** Metadatos para la ficha del modelo. */
  get info() {
    throw new Error('UlcerPredictor.info no implementado');
  }

  /**
   * @param {PredictionInput} _input
   * @returns {Promise<PredictionOutput>}
   */
  async predict(_input) {
    throw new Error('UlcerPredictor.predict no implementado');
  }
}

module.exports = UlcerPredictor;
