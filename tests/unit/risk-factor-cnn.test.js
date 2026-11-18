'use strict';

const { GRID, encodeGrid } = require('../../src/imaging/pointwise');
const {
  inputMaps,
  netLogit,
  isValidated,
  riskFactorProbability,
  loadRiskFactorModel,
} = require('../../src/services/predictors/riskFactorCnn');
const { literatureRisk } = require('../../src/services/predictors/literatureRisk');
const { resolvePredictorName } = require('../../src/services/predictors/PredictorFactory');
const RiskFactorLiteraturePredictor = require('../../src/services/predictors/RiskFactorLiteraturePredictor');

/** Pesos deterministas con las formas de RelCnn (scripts/ml/train_public.py). */
function fakeNet() {
  const fill = (k, shape) => {
    let i = 0;
    const build = (dims) =>
      dims.length === 1
        ? Array.from({ length: dims[0] }, () => Math.sin(0.37 * i++ + k) * 0.3)
        : Array.from({ length: dims[0] }, () => build(dims.slice(1)));
    return build(shape);
  };
  return {
    'c1.weight': fill(1, [8, 3, 3, 3]),
    'c1.bias': fill(2, [8]),
    'c2.weight': fill(3, [16, 8, 3, 3]),
    'c2.bias': fill(4, [16]),
    'fc.weight': fill(5, [1, 16]),
    'fc.bias': fill(6, [1]),
  };
}

const validacion = {
  n: 70,
  positivos: 26,
  auc: 0.79,
  aucIC95: [0.68, 0.89],
  aucDentroDeCentro: 0.84,
  pPermutacionDentroDeCentro: 0.0099,
};
const model = {
  version: 'cnn-neuropatia-v1',
  etiqueta: 'neuropatia',
  entrada: { escala: 1 },
  pesoPositivos: 1,
  redes: [fakeNet()],
  validacion,
};

function grids() {
  const izq = new Float32Array(GRID.w * GRID.h);
  const der = new Float32Array(GRID.w * GRID.h);
  for (let r = 0; r < GRID.h; r += 1) {
    for (let c = 0; c < GRID.w; c += 1) {
      izq[r * GRID.w + c] = 30 + Math.cos(0.11 * r) * 0.5;
      der[r * GRID.w + c] = 29 + Math.sin(0.07 * r + 0.13 * c) * 0.4;
    }
  }
  return { izq, der };
}

describe('CNN de factor de riesgo en JS', () => {
  test('el forward coincide con PyTorch (RelCnn, pesos y entrada deterministas)', () => {
    const n = GRID.w * GRID.h;
    const x = new Float32Array(3 * n);
    for (let r = 0; r < GRID.h; r += 1) {
      for (let c = 0; c < GRID.w; c += 1) {
        const i = r * GRID.w + c;
        x[i] = Math.cos(0.11 * r) * 0.5 + 0.02 * c;
        x[n + i] = Math.sin(0.07 * r + 0.13 * c) * 0.4;
        x[2 * n + i] = (r + c) % 7 ? 1 : 0;
      }
    }
    // Valor de referencia calculado con torch (scratch, mismos pesos y entrada).
    expect(netLogit(fakeNet(), x)).toBeCloseTo(0.787247896194458, 4);
  });

  test('entrada: cada pie relativo a su mediana y máscara de celdas con dato en ambos', () => {
    const { izq, der } = grids();
    der[0] = NaN;
    const x = inputMaps(izq, der, 2);
    const n = GRID.w * GRID.h;
    expect(x[2 * n]).toBe(0);
    expect(x[2 * n + 1]).toBe(1);
    expect(x[n]).toBe(0);
    // Un corrimiento constante de un pie no cambia la entrada.
    const izq2 = izq.map((v) => v + 3);
    expect(inputMaps(izq2, der, 2)[5]).toBeCloseTo(x[5], 5);
  });

  test('probabilidad en 0–1 y null sin grillas', () => {
    const { izq, der } = grids();
    const p = riskFactorProbability(model, { izq: encodeGrid(izq), der: encodeGrid(der) });
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    expect(riskFactorProbability(model, null)).toBeNull();
  });

  test('sólo se usa un modelo que cumple la regla fijada de antemano', () => {
    const conV = (v) => ({ ...model, validacion: { ...validacion, ...v } });
    expect(isValidated(model)).toBe(true);
    expect(isValidated(conV({ pPermutacionDentroDeCentro: 0.08 }))).toBe(false);
    expect(isValidated(conV({ aucIC95: [0.48, 0.8] }))).toBe(false);
    expect(isValidated(conV({ aucDentroDeCentro: 0.5 }))).toBe(false);
    expect(isValidated(conV({ positivos: 8 }))).toBe(false);
    expect(isValidated(null)).toBe(false);
    expect(loadRiskFactorModel()).toBeNull();
    expect(resolvePredictorName('riesgo-bibliografia', { outcomeModel: null, riskFactorModel: model })).toBe(
      'riesgo-neuropatia',
    );
    expect(resolvePredictorName('riesgo-bibliografia', { outcomeModel: null, riskFactorModel: null })).toBe(
      'riesgo-bibliografia',
    );
    expect(
      resolvePredictorName('riesgo-bibliografia', { modo: 'bibliografia', outcomeModel: null, riskFactorModel: model }),
    ).toBe('riesgo-bibliografia');
  });
});

describe('Prior IWGDF con la neuropatía estimada', () => {
  const hallazgo = { asimetria: 1, confirmada: null, tomas: 1 };
  const sinDato = { neuropatiaSinDato: true };

  test('sin dato de neuropatía: mezcla de los priors IWGDF 1 y 0 con la probabilidad del modelo', () => {
    const r0 = literatureRisk(hallazgo, { neuropatia: false });
    const r1 = literatureRisk(hallazgo, { neuropatia: true });
    const r = literatureRisk(hallazgo, sinDato, { probNeuropatia: 0.25 });
    expect(r.prior).toBeCloseTo(0.25 * r1.prior + 0.75 * r0.prior, 1);
    expect(r.grupoEstimado).toEqual({ probNeuropatia: 25 });
    expect(r.grupoPorDefecto).toBe(false);
    expect(r.grupoIwgdf).toBe(0);
    expect(literatureRisk(hallazgo, sinDato, { probNeuropatia: 0.8 }).grupoIwgdf).toBe(1);
  });

  test('con el dato clínico manda la ficha', () => {
    const r = literatureRisk(hallazgo, { neuropatia: false }, { probNeuropatia: 0.9 });
    expect(r.grupoIwgdf).toBe(0);
    expect(r.grupoEstimado).toBeNull();
    expect(literatureRisk(hallazgo, sinDato).grupoPorDefecto).toBe(true);
  });

  test('la estrategia informa la probabilidad y la usa para el prior', () => {
    const { izq, der } = grids();
    const pred = new RiskFactorLiteraturePredictor({ riskFactorModel: model });
    const out = { parametros: {}, puntual: { tomas: [{ toma: 1, izq: encodeGrid(izq), der: encodeGrid(der) }] } };
    const p = pred.riskParams(out, {});
    expect(p.probNeuropatia).toBeGreaterThan(0);
    expect(out.puntual.factorRiesgo.probabilidad).toBeCloseTo(p.probNeuropatia * 100, 0);
    expect(out.puntual.factorRiesgo.n).toBe(70);
    expect(pred.info.id).toBe('riesgo-neuropatia');
    // Sin modelo validado se comporta como el riesgo bibliográfico.
    const sin = new RiskFactorLiteraturePredictor({ riskFactorModel: null });
    expect(sin.riskParams({ parametros: { a: 1 }, puntual: out.puntual }, {})).toEqual({ a: 1 });
    expect(sin.info.id).toBe('riesgo-bibliografia');
  });
});
