'use strict';

/**
 * Modelo de PATRÓN TÉRMICO COMPATIBLE CON PIE DIABÉTICO.
 *
 * Regresión logística entrenada con una etiqueta REAL y validada: diabetes
 * (122 sujetos) vs control (45) en la base pública Hernández-Contreras et al.
 * 2019 («Plantar Thermogram Database for the Study of Diabetic Foot
 * Complications», IEEE DataPort, DOI 10.21227/tm4t-9n15, CC BY 4.0), con
 * scripts/ml/train_public.py. Coeficientes y métricas agregadas en
 * src/config/models/diabetic-pattern-logreg.json.
 *
 * QUÉ ES: cuánto se parece el patrón térmico plantar al de los sujetos con
 * diabetes de esa base. QUÉ NO ES: no predice úlcera ni riesgo de úlcera, y no
 * cambia la categoría de riesgo (que sigue saliendo del hallazgo térmico).
 *
 * Usa sólo features invariantes a la adquisición (src/imaging/thermalPattern.js):
 * temperaturas relativas a la mediana de cada pie y diferencias contralaterales,
 * porque la cámara y la escala de temperatura de la base no son las del portal.
 */
const fs = require('node:fs');
const path = require('node:path');
const { decodeGrid } = require('../../imaging/pointwise');
const { patternFeatures } = require('../../imaging/thermalPattern');

const PATTERN_MODEL_PATH = path.join(__dirname, '..', '..', 'config', 'models', 'diabetic-pattern-logreg.json');

let cached;
function loadPatternModel(file = PATTERN_MODEL_PATH) {
  if (file === PATTERN_MODEL_PATH && cached !== undefined) return cached;
  let m;
  try {
    m = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch {
    m = null;
  }
  if (file === PATTERN_MODEL_PATH) cached = m;
  return m;
}

/** Resumen del modelo (para el detalle técnico y los tooltips). */
function patternModelInfo(model) {
  if (!model) return null;
  const v = model.validacion || {};
  return {
    version: model.version,
    etiqueta: model.etiqueta,
    noPredice: model.noPredice,
    n: v.n ?? null,
    positivos: v.positivos ?? null,
    auc: v.auc ?? null,
    aucIC95: v.aucIC95 ?? null,
    pPermutacion: v.pPermutacion ?? null,
    metodo: v.metodo ?? null,
    aucEdadSola: v.aucEdadSola ?? null,
    subgrupoEdad: v.subgrupoEdad ?? null,
    externa: model.externa ?? null,
    limitaciones: model.limitaciones || [],
    features: (model.features || []).map((f) => f.nombre),
  };
}

/**
 * Probabilidad (0–100) de patrón compatible con pie diabético para una toma
 * (grillas serializadas). null si no hay modelo o la toma no tiene datos.
 */
function predictPattern(model, toma) {
  if (!model || !toma?.izq || !toma?.der) return null;
  const f = patternFeatures(decodeGrid(toma.izq), decodeGrid(toma.der));
  if (!f) return null;
  let logit = model.intercepto;
  const factores = model.features.map((d) => {
    const raw = f[d.key];
    const x = Number.isFinite(raw) ? raw : d.imputacion;
    const c = (d.coef * (x - d.media)) / d.desvio;
    logit += c;
    return {
      key: d.key,
      nombre: d.nombre,
      valor: Number.isFinite(raw) ? raw : null,
      unidad: d.unidad,
      contribucion: Math.round(c * 1000) / 1000,
    };
  });
  const probabilidad = Math.round(1000 / (1 + Math.exp(-logit))) / 10;
  return {
    probabilidad,
    tomaUsada: toma.toma ?? null,
    factores: factores.sort((a, b) => Math.abs(b.contribucion) - Math.abs(a.contribucion)).slice(0, 4),
    version: model.version,
    n: model.validacion?.n ?? null,
    positivos: model.validacion?.positivos ?? null,
    auc: model.validacion?.auc ?? null,
    aucIC95: model.validacion?.aucIC95 ?? null,
  };
}

module.exports = { PATTERN_MODEL_PATH, loadPatternModel, predictPattern, patternModelInfo };
