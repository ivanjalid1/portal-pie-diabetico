'use strict';

const fs = require('node:fs');
const LiteratureRiskPredictor = require('./LiteratureRiskPredictor');
const { decodeGrid } = require('../../imaging/pointwise');
const { patternFeatures } = require('../../imaging/thermalPattern');
const { categoryFor } = require('../../config/domain');

/**
 * Modelo de úlcera ENTRENADO con los desenlaces del portal
 * (scripts/ml/train-outcome.py). Se genera con datos reales, por eso vive en
 * data-local/models/ (ignorada por git y Vercel). OUTCOME_MODEL cambia la ruta.
 */
const OUTCOME_MODEL_PATH =
  process.env.OUTCOME_MODEL || require('../../config/localData').localDataPath('models', 'outcome-logreg.json');

/** Requisitos para reemplazar al riesgo bibliográfico. */
const REQUISITOS = Object.freeze({ positivos: 10, negativos: 10, aucMinima: 0.7 });

function loadOutcomeModel(file = OUTCOME_MODEL_PATH) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

/** ¿El modelo tiene casos suficientes y una validación que discrimina? */
function isValidated(model) {
  const v = model?.validacion;
  if (!v || !Array.isArray(model.features) || !model.features.length) return false;
  const pos = v.positivos ?? 0;
  const neg = (v.n ?? 0) - pos;
  const ic = v.aucIC95 || [0, 0];
  return pos >= REQUISITOS.positivos && neg >= REQUISITOS.negativos && v.auc >= REQUISITOS.aucMinima && ic[0] > 0.5;
}

function applyOutcomeModel(model, toma) {
  if (!model || !toma?.izq || !toma?.der) return null;
  const f = patternFeatures(decodeGrid(toma.izq), decodeGrid(toma.der));
  if (!f) return null;
  let logit = model.intercepto;
  for (const d of model.features) {
    const x = Number.isFinite(f[d.key]) ? f[d.key] : d.imputacion;
    logit += (d.coef * (x - d.media)) / d.desvio;
  }
  return Math.round(1000 / (1 + Math.exp(-logit))) / 10;
}

/**
 * Estrategia `riesgo-entrenado`: el riesgo sale del modelo de lesión validado
 * con los desenlaces del portal (toma 1, como en el entrenamiento). El riesgo
 * bibliográfico se sigue calculando y queda en el detalle técnico.
 */
class TrainedOutcomePredictor extends LiteratureRiskPredictor {
  constructor({ outcomeModel = loadOutcomeModel(), ...rest } = {}) {
    super(rest);
    this.outcomeModel = outcomeModel;
  }

  get info() {
    const base = super.info;
    const v = this.outcomeModel?.validacion || {};
    return {
      ...base,
      id: 'riesgo-entrenado',
      version: this.outcomeModel?.version || 'lesion-logreg',
      nombre: 'Riesgo de úlcera: modelo entrenado con los desenlaces del portal',
      descripcion: `Regresión logística sobre features térmicas de la toma 1, entrenada con ${v.positivos ?? '—'} lesiones y ${(v.n ?? 0) - (v.positivos ?? 0)} pacientes sin lesión registrados en el portal (AUC ${v.auc ?? '—'}).`,
      entrenado: { n: v.n ?? null, positivos: v.positivos ?? null, auc: v.auc ?? null, aucIC95: v.aucIC95 ?? null },
    };
  }

  async predict(input) {
    const out = await super.predict(input);
    const t1 = out.puntual?.tomas.find((t) => t.toma === 1);
    const prob = isValidated(this.outcomeModel) ? applyOutcomeModel(this.outcomeModel, t1) : null;
    if (prob === null) return out;
    const p = out.parametros || {};
    const v = this.outcomeModel.validacion;
    out.puntual.riesgoEntrenado = {
      probabilidad: prob,
      version: this.outcomeModel.version,
      n: v.n,
      positivos: v.positivos,
      auc: v.auc,
      aucIC95: v.aucIC95,
    };
    out.puntual.categoriaPor = 'modelo_entrenado';
    return {
      ...out,
      probabilidad: prob,
      categoria: categoryFor(prob, { moderado: p.corteModerado, alto: p.corteAlto }),
    };
  }
}

module.exports = TrainedOutcomePredictor;
module.exports.loadOutcomeModel = loadOutcomeModel;
module.exports.isValidated = isValidated;
module.exports.OUTCOME_MODEL_PATH = OUTCOME_MODEL_PATH;
module.exports.REQUISITOS = REQUISITOS;
