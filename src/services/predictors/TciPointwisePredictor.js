'use strict';

const PointwisePredictor = require('./PointwisePredictor');
const { loadModel, TCI_MODEL_PATH } = require('./pointwiseModel');

/**
 * Estrategia `puntual-tci`: el mismo análisis punto a punto que
 * `PointwisePredictor`, pero la probabilidad sale de la regresión logística
 * EXPERIMENTAL sobre TCI + área caliente + |ΔT| p95
 * (src/config/models/pointwise-tci-logreg.json, scripts/ml/train_models.py).
 *
 * Se selecciona con PREDICTOR=puntual-tci. Igual que el preliminar, si su AUC
 * de validación es < 0,7 la categoría sale del hallazgo térmico y la
 * probabilidad se rotula «no validado». Si el archivo del modelo no existe, se
 * comporta como el análisis punto a punto sin probabilidad.
 */
class TciPointwisePredictor extends PointwisePredictor {
  constructor({ model = loadModel(TCI_MODEL_PATH), ...rest } = {}) {
    super({ model, ...rest });
  }

  get info() {
    const base = super.info;
    return {
      ...base,
      id: 'puntual-tci',
      version: 'puntual-tci-v1',
      nombre: 'Análisis punto a punto + TCI + modelo experimental',
      descripcion:
        'Análisis punto a punto con el índice de cambio térmico (TCI, Hernández-Contreras et al. 2017) contra un patrón de referencia; la probabilidad proviene de una regresión logística experimental sobre TCI, área caliente y |ΔT| p95.',
    };
  }
}

module.exports = TciPointwisePredictor;
