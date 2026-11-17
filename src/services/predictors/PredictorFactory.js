'use strict';

const MockUlcerPredictor = require('./MockUlcerPredictor');
const PointwisePredictor = require('./PointwisePredictor');
const TciPointwisePredictor = require('./TciPointwisePredictor');
const { LogisticRegressionPredictor, CnnPredictor } = require('./FuturePredictors');

const REGISTRY = {
  puntual: (opts) => new PointwisePredictor(opts),
  'puntual-tci': (opts) => new TciPointwisePredictor(opts),
  mock: () => new MockUlcerPredictor(),
  logreg: () => new LogisticRegressionPredictor(),
  cnn: () => new CnnPredictor({ endpointUrl: process.env.CNN_ENDPOINT_URL }),
};

/** Fábrica de estrategias de predicción seleccionadas por `PREDICTOR`. */
function createPredictor(name = 'puntual', opts = {}) {
  const make = REGISTRY[name];
  if (!make) throw new Error(`Predictor desconocido: "${name}". Opciones: ${Object.keys(REGISTRY).join(', ')}`);
  return make(opts);
}

module.exports = { createPredictor, PREDICTORS: Object.keys(REGISTRY) };
