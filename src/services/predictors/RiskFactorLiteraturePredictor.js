'use strict';

const LiteratureRiskPredictor = require('./LiteratureRiskPredictor');
const { loadRiskFactorModel, isValidated, riskFactorProbability } = require('./riskFactorCnn');

/**
 * Estrategia `riesgo-neuropatia`: el riesgo de úlcera calibrado con la
 * bibliografía (§8.9) con el prior IWGDF informado por un modelo ENTRENADO con
 * la cohorte propia: una CNN que estima la probabilidad de neuropatía desde el
 * mapa térmico relativo de la toma 1 (riskFactorCnn.js, §8.10).
 *
 * - Con neuropatía registrada en la ficha, manda el dato clínico.
 * - Sin ese dato (antes: grupo IWGDF por defecto), el prior es
 *   p × prior(IWGDF 1) + (1 − p) × prior(IWGDF 0), con p de la CNN.
 * - La probabilidad de neuropatía se informa siempre en «Detalle técnico».
 */
class RiskFactorLiteraturePredictor extends LiteratureRiskPredictor {
  constructor({ riskFactorModel = loadRiskFactorModel(), ...rest } = {}) {
    super(rest);
    this.riskFactorModel = isValidated(riskFactorModel) ? riskFactorModel : null;
  }

  get info() {
    const base = super.info;
    const v = this.riskFactorModel?.validacion;
    if (!v) return base;
    return {
      ...base,
      id: 'riesgo-neuropatia',
      version: `riesgo-bibliografia-v2+${this.riskFactorModel.version}`,
      nombre: 'Riesgo de úlcera calibrado con la bibliografía, con prior IWGDF de un modelo entrenado',
      descripcion: `${base.descripcion} Si falta el dato de neuropatía, el grupo IWGDF sale de una CNN entrenada con la cohorte (${v.n} pacientes, ${v.positivos} con neuropatía; AUC ${v.auc}).`,
      factorRiesgo: {
        etiqueta: this.riskFactorModel.etiqueta,
        n: v.n,
        positivos: v.positivos,
        auc: v.auc,
        aucIC95: v.aucIC95,
      },
    };
  }

  riskParams(out, input) {
    const p = super.riskParams(out, input);
    const model = this.riskFactorModel;
    const t1 = out.puntual?.tomas.find((t) => t.toma === 1) || out.puntual?.tomas[0];
    const prob = model ? riskFactorProbability(model, t1) : null;
    if (prob === null) return p;
    const v = model.validacion;
    out.puntual.factorRiesgo = {
      etiqueta: model.etiqueta,
      probabilidad: Math.round(prob * 1000) / 10,
      version: model.version,
      toma: t1.toma,
      n: v.n,
      positivos: v.positivos,
      auc: v.auc,
      aucIC95: v.aucIC95,
      aucDentroDeCentro: v.aucDentroDeCentro,
      pPermutacion: v.pPermutacionDentroDeCentro,
      entrenamiento:
        'CNN preentrenada con la base pública 2019 (diabetes vs control) y ajustada con la neuropatía registrada en la cohorte',
    };
    return { ...p, probNeuropatia: prob };
  }
}

module.exports = RiskFactorLiteraturePredictor;
