'use strict';

const MockUlcerPredictor = require('./MockUlcerPredictor');
const { LogisticRegressionPredictor, CnnPredictor } = require('./FuturePredictors');

const REGISTRY = {
  mock: () => new MockUlcerPredictor(),
  logreg: () => new LogisticRegressionPredictor(),
  cnn: () => new CnnPredictor({ endpointUrl: process.env.CNN_ENDPOINT_URL }),
};

/** Fábrica de estrategias de predicción seleccionadas por `PREDICTOR`. */
function createPredictor(name = 'mock') {
  const make = REGISTRY[name];
  if (!make) throw new Error(`Predictor desconocido: "${name}". Opciones: ${Object.keys(REGISTRY).join(', ')}`);
  return make();
}

module.exports = { createPredictor, PREDICTORS: Object.keys(REGISTRY) };
