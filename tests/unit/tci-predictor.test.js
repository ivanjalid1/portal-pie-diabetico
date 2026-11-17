'use strict';

const TciPointwisePredictor = require('../../src/services/predictors/TciPointwisePredictor');
const PointwisePredictor = require('../../src/services/predictors/PointwisePredictor');
const UlcerPredictor = require('../../src/services/predictors/UlcerPredictor');
const { createPredictor } = require('../../src/services/predictors/PredictorFactory');
const { featureVector, applyModel } = require('../../src/services/predictors/pointwiseModel');
const { GRID, encodeGrid } = require('../../src/imaging/pointwise');
const { Patient, Study } = require('../../src/models');
const { fakeIs2 } = require('../helpers/is2');

const N = GRID.w * GRID.h;
const flat = (v) => new Float32Array(N).fill(v);
const patient = new Patient({ codigo: 'P.HC998', fechaNacimiento: '1960-01-01', sexo: 'F', tipoDm: 'II' });
const study = new Study({ fechaHora: '2026-10-01T12:00:00.000Z', fechaToma1: '2026-09-01T12:00:00.000Z' });

/** Modelo sintético con el formato de pointwise-tci-logreg.json. */
const model = (auc) => ({
  version: 'test-tci',
  desenlace: 'sintético',
  umbralPixel: 1,
  intercepto: 0,
  features: [
    { key: 'tci', nombre: 'TCI', unidad: '°C', media: 1, desvio: 1, coef: 1 },
    { key: 'areaCalientePct', nombre: 'Área', unidad: '%', media: 0, desvio: 10, coef: 0 },
    { key: 'p95Abs', nombre: 'p95', unidad: '°C', media: 0, desvio: 1, coef: 0 },
  ],
  validacion: { n: 40, auc, aucIC95: [0.4, 0.6], metodo: 'test' },
});
/** Referencia sintética a 30 °C con tres miembros (uno es el propio paciente). */
const tciStore = () => ({
  fuente: 'cohorte',
  members: [
    { id: 'A', izq: flat(30), der: flat(30) },
    { id: 'B', izq: flat(30), der: flat(30) },
    { id: 'P.HC998', izq: flat(40), der: flat(40) },
  ],
});

describe('TciPointwisePredictor (estrategia puntual-tci)', () => {
  it('se registra en la fábrica e implementa UlcerPredictor', () => {
    const p = createPredictor('puntual-tci');
    expect(p).toBeInstanceOf(TciPointwisePredictor);
    expect(p).toBeInstanceOf(PointwisePredictor);
    expect(p).toBeInstanceOf(UlcerPredictor);
    expect(p.info.id).toBe('puntual-tci');
    expect(p.info.version).toBe('puntual-tci-v1');
  });

  it('featureVector toma el TCI de la toma y las métricas de asimetría', () => {
    const toma = { izq: encodeGrid(flat(31)), der: encodeGrid(flat(31)), tci: { valor: 2.5, puntual: 2, patron: 0.1 } };
    expect(featureVector(toma, { keys: ['tci', 'areaCalientePct', 'tciPatron'] })).toEqual([2.5, 0, 0.1]);
    expect(featureVector({ ...toma, tci: null }, { keys: ['tci'] })).toBeNull();
    // Por defecto, las features del modelo preliminar (sin TCI).
    expect(featureVector(toma)).toHaveLength(3);
  });

  it('calcula el TCI contra la referencia excluyendo al propio paciente (LOO) y aplica el modelo', async () => {
    const p = new TciPointwisePredictor({ model: model(0.55), tciStore: tciStore() });
    const grids = { toma1: { izq: encodeGrid(flat(32)), der: encodeGrid(flat(32)) } };
    const out = await p.predict({ patient, study, hints: { puntual: grids } });
    const tci = out.puntual.tomas[0].tci;
    expect(tci.referencia.miembros).toBe(2);
    expect(tci.referencia.looExcluido).toBe(true);
    expect(tci.valor).toBeCloseTo(2, 5);
    expect(tci.clase).toBe(1);
    // logit = (2 − 1) / 1 · 1 = 1 → 73,1 %
    expect(out.probabilidad).toBeCloseTo(73.1, 1);
    expect(out.predictorVersion).toBe('puntual-tci-v1');
    // AUC < 0,7: la categoría sale del hallazgo térmico, no del modelo.
    expect(out.puntual.categoriaPor).toBe('hallazgo_termico');
    expect(out.factores.map((f) => f.key)).toContain('tci');
  });

  it('con AUC de validación ≥ 0,7 la categoría usa la probabilidad del modelo', async () => {
    const p = new TciPointwisePredictor({ model: model(0.8), tciStore: tciStore() });
    const grids = { toma1: { izq: encodeGrid(flat(32)), der: encodeGrid(flat(32)) } };
    const out = await p.predict({ patient, study, hints: { puntual: grids } });
    expect(out.puntual.categoriaPor).toBe('modelo');
  });

  it('sin modelo analiza igual (TCI incluido) y no inventa una probabilidad', async () => {
    const p = new TciPointwisePredictor({ model: null, tciStore: tciStore() });
    const out = await p.predict({
      patient,
      study,
      images: [{ slot: 'toma1', buffer: fakeIs2(), mime: 'application/x-fluke-is2' }],
    });
    expect(out.simulado).toBe(false);
    expect(out.puntual.tomas[0].tci).toBeTruthy();
    expect(out.puntual.tomas[0].segmentacion).toBe('clasica');
    expect(out.probabilidad).toBe(0);
    expect(applyModel(null, [1])).toBeNull();
  });
});
