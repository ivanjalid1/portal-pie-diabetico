'use strict';

const MockUlcerPredictor = require('../../src/services/predictors/MockUlcerPredictor');
const { createPredictor } = require('../../src/services/predictors/PredictorFactory');
const { LogisticRegressionPredictor } = require('../../src/services/predictors/FuturePredictors');
const UlcerPredictor = require('../../src/services/predictors/UlcerPredictor');
const { Patient, Study } = require('../../src/models');
const { categoryFor, ROIS, thermalGroup } = require('../../src/config/domain');

const basePatient = (over = {}) =>
  new Patient({
    codigo: 'DEMO-002',
    fechaNacimiento: '1960-01-01',
    sexo: 'F',
    tipoDm: 'II',
    aniosEvolucionDm: 12,
    insulinorequiriente: false,
    tabaquismo: false,
    neuropatia: false,
    ...over,
  });
const study = new Study({ fechaHora: '2026-10-01T12:00:00.000Z', tempAmbiente: 22.5, humedadRelativa: 50 });

describe('MockUlcerPredictor (estrategia simulada)', () => {
  const predictor = new MockUlcerPredictor();

  it('implementa la interfaz UlcerPredictor', () => {
    expect(predictor).toBeInstanceOf(UlcerPredictor);
    expect(predictor.info.version).toBe('mock-v0');
  });

  it('es determinístico para el mismo paciente y fecha', async () => {
    const a = await predictor.predict({ patient: basePatient(), study, images: [] });
    const b = await predictor.predict({ patient: basePatient(), study, images: [] });
    expect(a).toEqual(b);
  });

  it('devuelve 7 ROIs con temperaturas en rango y ΔT ≤ 2,8 °C', async () => {
    const r = await predictor.predict({ patient: basePatient(), study, images: [] });
    expect(r.rois.map((x) => x.roi)).toEqual(ROIS.map((x) => x.key));
    for (const roi of r.rois) {
      expect(roi.avgDer).toBeGreaterThanOrEqual(23);
      expect(roi.avgDer).toBeLessThanOrEqual(34);
      expect(roi.avgIzq).toBeGreaterThanOrEqual(23);
      expect(roi.avgIzq).toBeLessThanOrEqual(34);
      expect(Math.abs(roi.deltaT)).toBeLessThanOrEqual(2.81);
      expect(roi.deltaT).toBeCloseTo(roi.avgDer - roi.avgIzq, 1);
    }
  });

  it('informa probabilidad, categoría coherente con los cortes, umbral y grupo P/C', async () => {
    const r = await predictor.predict({ patient: basePatient(), study, images: [] });
    expect(r.probabilidad).toBeGreaterThanOrEqual(0);
    expect(r.probabilidad).toBeLessThanOrEqual(100);
    expect(r.categoria).toBe(categoryFor(r.probabilidad));
    expect(r.horizonteSemanas).toBe(6);
    expect(r.umbral).toBe(1);
    expect(['P', 'C']).toContain(r.grupo);
    expect(r.factores.map((f) => f.key)).toEqual(
      expect.arrayContaining([
        'tabaquismo',
        'insulinorequiriente',
        'delta_dedo_mayor',
        'anios_dm',
        'grado_neuropatia',
        'delta_metatarso',
      ]),
    );
    expect(r.simulado).toBe(true);
  });

  it('asigna mayor probabilidad a un perfil de alto riesgo clínico', async () => {
    const low = await predictor.predict({
      patient: basePatient({ codigo: 'P.HC100', aniosEvolucionDm: 2 }),
      study,
      images: [],
    });
    const high = await predictor.predict({
      patient: basePatient({
        codigo: 'P.HC100',
        aniosEvolucionDm: 25,
        tabaquismo: true,
        insulinorequiriente: true,
        neuropatia: true,
        neuropatiaPuntaje: 8,
        ulceraPreviaDer: true,
      }),
      study,
      images: [],
    });
    expect(high.probabilidad).toBeGreaterThan(low.probabilidad);
  });

  it('respeta un umbral de asimetría configurable (2,2 °C de la literatura)', async () => {
    const strict = new MockUlcerPredictor({ umbral: 2.2 });
    const r = await strict.predict({ patient: basePatient(), study, images: [] });
    expect(r.umbral).toBe(2.2);
    expect(r.grupo).toBe(thermalGroup(r.rois, 2.2).grupo);
  });
});

describe('Clasificación térmica', () => {
  const rois = (dts, general = 0) => [
    ...dts.map((d, i) => ({ roi: `r${i}`, deltaT: d })),
    { roi: 'general', deltaT: general },
  ];
  it('grupo P si alguna ROI supera el umbral', () => {
    expect(thermalGroup(rois([0.2, -1.1]), 1).grupo).toBe('P');
    expect(thermalGroup(rois([0.2, 0.9]), 1).grupo).toBe('C');
  });
  it('simétrico si |ΔT general| < 1', () => {
    expect(thermalGroup(rois([0.2], 0.5)).simetrico).toBe(true);
    expect(thermalGroup(rois([0.2], -1.0)).simetrico).toBe(false);
  });
  it('categorías con cortes en 50 % y 70 %', () => {
    expect(categoryFor(49.9)).toBe('sin_riesgo');
    expect(categoryFor(50)).toBe('moderado');
    expect(categoryFor(70)).toBe('alto');
  });
});

describe('PredictorFactory', () => {
  it('crea la estrategia mock por defecto y rechaza nombres desconocidos', () => {
    expect(createPredictor('mock')).toBeInstanceOf(MockUlcerPredictor);
    expect(createPredictor('logreg')).toBeInstanceOf(LogisticRegressionPredictor);
    expect(() => createPredictor('xyz')).toThrow(/desconocido/);
  });
  it('las estrategias futuras declaran que aún no están implementadas', async () => {
    await expect(createPredictor('logreg').predict({})).rejects.toThrow(/no está implementado/);
  });
});
