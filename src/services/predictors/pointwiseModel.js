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
/** Modelo experimental con TCI (scripts/ml/train_models.py --export). */
const TCI_MODEL_PATH = path.join(__dirname, '..', '..', 'config', 'models', 'pointwise-tci-logreg.json');

/** Comparación de modelos (sólo agregados: AUC, IC y n; scripts/ml/train_models.py). */
const COMPARISON_PATH = path.join(__dirname, '..', '..', 'config', 'models', 'model-comparison.json');

/** Features que salen del TCI de la toma (el resto, de las métricas de asimetría). */
const TCI_FEATURES = Object.freeze({ tci: 'valor', tciPuntual: 'puntual', tciPatron: 'patron' });

/** Features (en el orden del vector). Se calculan con el umbral propio del modelo. */
const FEATURES = Object.freeze([
  Object.freeze({ key: 'areaCalientePct', nombre: 'Área con |ΔT| sobre el umbral', unidad: '%' }),
  Object.freeze({ key: 'mediaAbs', nombre: '|ΔT| medio entre pies', unidad: '°C' }),
  Object.freeze({ key: 'p95Abs', nombre: '|ΔT| percentil 95', unidad: '°C' }),
]);

const cache = new Map();

function loadModel(file = MODEL_PATH) {
  if (cache.has(file)) return cache.get(file);
  if (!fs.existsSync(file)) return null;
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache.set(file, m);
  return m;
}

/**
 * Vector de features de una toma (grillas serializadas) con el umbral y las
 * zonas excluidas indicadas. `keys` por defecto son las del modelo preliminar;
 * las claves del TCI (`tci`, `tciPuntual`, `tciPatron`) se toman de `toma.tci`.
 * Devuelve null si falta alguna.
 */
function featureVector(toma, { umbralPixel = 1, keys = FEATURES.map((f) => f.key) } = {}) {
  const m = asymmetryMetrics(decodeGrid(toma.izq), decodeGrid(toma.der), {
    umbralPixel,
    zonasExcluidas: toma.zonasNoAnalizadas || [],
  });
  if (!m) return null;
  const x = keys.map((k) => (k in TCI_FEATURES ? (toma.tci?.[TCI_FEATURES[k]] ?? null) : (m[k] ?? null)));
  return x.every((v) => Number.isFinite(v)) ? x : null;
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

module.exports = {
  FEATURES,
  TCI_FEATURES,
  MODEL_PATH,
  TCI_MODEL_PATH,
  COMPARISON_PATH,
  loadModel,
  featureVector,
  applyModel,
};
