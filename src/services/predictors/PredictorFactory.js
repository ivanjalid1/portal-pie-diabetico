'use strict';

const MockUlcerPredictor = require('./MockUlcerPredictor');
const PointwisePredictor = require('./PointwisePredictor');
const TciPointwisePredictor = require('./TciPointwisePredictor');
const LiteratureRiskPredictor = require('./LiteratureRiskPredictor');
const TrainedOutcomePredictor = require('./TrainedOutcomePredictor');
const RiskFactorLiteraturePredictor = require('./RiskFactorLiteraturePredictor');
const riskFactorCnn = require('./riskFactorCnn');
const { LogisticRegressionPredictor, CnnPredictor } = require('./FuturePredictors');

const REGISTRY = {
  'riesgo-bibliografia': (opts) => new LiteratureRiskPredictor(opts),
  'riesgo-entrenado': (opts) => new TrainedOutcomePredictor(opts),
  'riesgo-neuropatia': (opts) => new RiskFactorLiteraturePredictor(opts),
  puntual: (opts) => new PointwisePredictor(opts),
  'puntual-tci': (opts) => new TciPointwisePredictor(opts),
  mock: () => new MockUlcerPredictor(),
  logreg: () => new LogisticRegressionPredictor(),
  cnn: () => new CnnPredictor({ endpointUrl: process.env.CNN_ENDPOINT_URL }),
};

/**
 * Cambio automático al modelo entrenado: con `riesgo-bibliografia` (por
 * defecto) y RIESGO_MODELO = auto (por defecto), si existe el modelo de lesión
 * de scripts/ml/train-outcome.py y está validado (≥ 10 lesiones, ≥ 10 sin
 * lesión, AUC ≥ 0,7 con IC inferior > 0,5), se usa `riesgo-entrenado`.
 * RIESGO_MODELO = bibliografia lo impide; = entrenado lo fuerza (si el modelo
 * no está validado, igual cae en el riesgo bibliográfico estudio a estudio).
 * Si no hay modelo de lesión validado pero sí la CNN de neuropatía validada
 * (riskFactorCnn.js, §8.10), se usa `riesgo-neuropatia`: el mismo riesgo
 * bibliográfico con el prior IWGDF estimado por la CNN cuando falta el dato.
 */
function resolvePredictorName(name = 'riesgo-bibliografia', { modo = 'auto', outcomeModel, riskFactorModel } = {}) {
  if (name !== 'riesgo-bibliografia' || modo === 'bibliografia') return name;
  if (modo === 'entrenado') return 'riesgo-entrenado';
  const model = outcomeModel === undefined ? TrainedOutcomePredictor.loadOutcomeModel() : outcomeModel;
  if (TrainedOutcomePredictor.isValidated(model)) return 'riesgo-entrenado';
  const rf = riskFactorModel === undefined ? riskFactorCnn.loadRiskFactorModel() : riskFactorModel;
  return riskFactorCnn.isValidated(rf) ? 'riesgo-neuropatia' : name;
}

/** Fábrica de estrategias de predicción seleccionadas por `PREDICTOR`. */
function createPredictor(name = 'riesgo-bibliografia', opts = {}) {
  const { riesgoModelo = 'auto', ...rest } = opts;
  const resolved = resolvePredictorName(name, { modo: riesgoModelo });
  const make = REGISTRY[resolved];
  if (!make) throw new Error(`Predictor desconocido: "${name}". Opciones: ${Object.keys(REGISTRY).join(', ')}`);
  return make(rest);
}

module.exports = { createPredictor, resolvePredictorName, PREDICTORS: Object.keys(REGISTRY) };
