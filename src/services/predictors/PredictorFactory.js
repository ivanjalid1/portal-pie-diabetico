'use strict';

const MockUlcerPredictor = require('./MockUlcerPredictor');
const PointwisePredictor = require('./PointwisePredictor');
const { LogisticRegressionPredictor, CnnPredictor } = require('./FuturePredictors');

const REGISTRY = {
  puntual: () => new PointwisePredictor(),
  mock: () => new MockUlcerPredictor(),
  logreg: () => new LogisticRegressionPredictor(),
  cnn: () => new CnnPredictor({ endpointUrl: process.env.CNN_ENDPOINT_URL }),
};

/** Fábrica de estrategias de predicción seleccionadas por `PREDICTOR`. */
function createPredictor(name = 'puntual') {
  const make = REGISTRY[name];
  if (!make) throw new Error(`Predictor desconocido: "${name}". Opciones: ${Object.keys(REGISTRY).join(', ')}`);
  return make();
}

module.exports = { createPredictor, PREDICTORS: Object.keys(REGISTRY) };
