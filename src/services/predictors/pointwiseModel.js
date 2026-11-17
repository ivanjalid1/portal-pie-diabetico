'use strict';

/**
 * Modelo PRELIMINAR sobre features punto a punto: regresión logística cuyos
 * coeficientes produce `scripts/train-pointwise-model.js` y se guardan en
 * src/config/models/pointwise-logreg.json (sólo coeficientes, medias, desvíos
 * y métricas agregadas: ningún dato identificatorio).
 *
 * Desenlace: el mismo sustituto que la Parte 1 (HbA1c > 7 %), porque en la
 * cohorte casi no hubo úlceras registradas. Por eso la probabilidad NO es una
 * probabilidad clínica de úlcera validada: se muestra como «modelo preliminar»
 * junto con su AUC de validación cruzada y el n.
 */
const fs = require('node:fs');
const path = require('node:path');
const { decodeGrid, asymmetryMetrics } = require('../../imaging/pointwise');

const MODEL_PATH = path.join(__dirname, '..', '..', 'config', 'models', 'pointwise-logreg.json');

/** Features (en el orden del vector). Se calculan con el umbral propio del modelo. */
const FEATURES = Object.freeze([
  Object.freeze({ key: 'areaCalientePct', nombre: 'Área con |ΔT| sobre el umbral', unidad: '%' }),
  Object.freeze({ key: 'mediaAbs', nombre: '|ΔT| medio entre pies', unidad: '°C' }),
  Object.freeze({ key: 'p95Abs', nombre: '|ΔT| percentil 95', unidad: '°C' }),
]);

let cached = null;

function loadModel(file = MODEL_PATH) {
  if (file === MODEL_PATH && cached) return cached;
  if (!fs.existsSync(file)) return null;
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (file === MODEL_PATH) cached = m;
  return m;
}

/** Vector de features de una toma (grillas serializadas) con el umbral y las zonas excluidas indicadas. */
function featureVector(toma, { umbralPixel = 1 } = {}) {
  const m = asymmetryMetrics(decodeGrid(toma.izq), decodeGrid(toma.der), {
    umbralPixel,
    zonasExcluidas: toma.zonasNoAnalizadas || [],
  });
  return m ? FEATURES.map((f) => m[f.key]) : null;
}

/**
 * Probabilidad (0–100) y contribución de cada feature al log-odds.
 * @returns {{probabilidad:number, factores:Array}|null}
 */
function applyModel(model, x) {
  if (!model || !x) return null;
  let logit = model.intercepto;
  const factores = model.features.map((f, j) => {
    const z = (x[j] - f.media) / f.desvio;
    const contribucion = f.coef * z;
    logit += contribucion;
    return {
      key: f.key,
      nombre: f.nombre,
      valor: `${String(Math.round(x[j] * 10) / 10).replace('.', ',')}${f.unidad === '%' ? ' %' : ` ${f.unidad}`}`,
      contribucion: Math.round(contribucion * 1000) / 1000,
    };
  });
  return { probabilidad: Math.round((1000 / (1 + Math.exp(-logit))) * 1) / 10, factores };
}

module.exports = { FEATURES, MODEL_PATH, loadModel, featureVector, applyModel };
