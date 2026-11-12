'use strict';

const UlcerPredictor = require('./UlcerPredictor');

/**
 * Estrategias previstas para cuando el algoritmo de procesamiento de imágenes
 * esté disponible. Se dejan declaradas para documentar el punto de extensión:
 * basta con implementar `predict()` y registrarlas en `PredictorFactory`.
 */

/**
 * Regresión logística sobre features térmicas (ΔT por ROI) + variables clínicas,
 * equivalente al modelo de referencia de la Parte 1 (C = 0,5; validación LOO).
 *
 * Pasos esperados en `predict()`:
 *  1. Segmentar ambos pies en la termografía (Imagen 1), usando la Imagen 2
 *     (visible / IR-Fusion) para mejorar el contorno.
 *  2. Ubicar las 6 ROIs por pie y calcular media, máximo y mínimo.
 *  3. Construir el vector de features y aplicar el modelo serializado
 *     (coeficientes + escalado) exportado desde el entorno de entrenamiento.
 */
class LogisticRegressionPredictor extends UlcerPredictor {
  constructor({ coefficients } = {}) {
    super();
    this.coefficients = coefficients || null;
  }

  get info() {
    return {
      id: 'logreg',
      version: 'logreg-v1 (pendiente)',
      nombre: 'Regresión logística',
      descripcion: 'Modelo de la Parte 1 aplicado sobre ROIs extraídas automáticamente.',
    };
  }

  async predict() {
    throw new Error('LogisticRegressionPredictor: el procesamiento de imágenes aún no está implementado.');
  }
}

/** Red neuronal convolucional que estima el riesgo directamente desde las imágenes. */
class CnnPredictor extends UlcerPredictor {
  constructor({ endpointUrl } = {}) {
    super();
    this.endpointUrl = endpointUrl || null;
  }

  get info() {
    return {
      id: 'cnn',
      version: 'cnn-v1 (pendiente)',
      nombre: 'Red convolucional',
      descripcion: 'Inferencia remota (p. ej. microservicio Python) a partir de ambas imágenes.',
    };
  }

  async predict() {
    throw new Error('CnnPredictor: modelo no disponible todavía.');
  }
}

module.exports = { LogisticRegressionPredictor, CnnPredictor };
