'use strict';

const MockUlcerPredictor = require('../../src/services/predictors/MockUlcerPredictor');
const { createPredictor } = require('../../src/services/predictors/PredictorFactory');
const { LogisticRegressionPredictor } = require('../../src/services/predictors/FuturePredictors');
const UlcerPredictor = require('../../src/services/predictors/UlcerPredictor');
const { Patient, Study, AnalysisResult } = require('../../src/models');
const { categoryFor, ROIS, thermalGroup } = require('../../src/config/domain');
const { fakeIs2 } = require('../helpers/is2');

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
const study = new Study({
  fechaHora: '2026-10-01T12:00:00.000Z',
  fechaToma1: '2026-09-01T12:00:00.000Z',
  tempAmbiente: 22.5,
  humedadRelativa: 50,
});

describe('MockUlcerPredictor (análisis comparativo de dos tomas)', () => {
  const predictor = new MockUlcerPredictor();

  it('implementa la interfaz UlcerPredictor', () => {
    expect(predictor).toBeInstanceOf(UlcerPredictor);
    expect(predictor.info.version).toBe('mock-v0');
  });

  it('es determinístico para el mismo paciente y fechas', async () => {
    const a = await predictor.predict({ patient: basePatient(), study, images: [] });
    const b = await predictor.predict({ patient: basePatient(), study, images: [] });
    expect(a).toEqual(b);
  });

  it('devuelve las 7 ROIs de cada toma con temperaturas en rango y ΔT ≤ 2,8 °C', async () => {
    const r = await predictor.predict({ patient: basePatient(), study, images: [] });
    for (const list of [r.roisToma1, r.rois]) {
      expect(list.map((x) => x.roi)).toEqual(ROIS.map((x) => x.key));
      for (const roi of list) {
        expect(roi.avgDer).toBeGreaterThanOrEqual(23);
        expect(roi.avgIzq).toBeLessThanOrEqual(34);
        expect(Math.abs(roi.deltaT)).toBeLessThanOrEqual(2.81);
        expect(roi.deltaT).toBeCloseTo(roi.avgDer - roi.avgIzq, 1);
      }
    }
    expect(r.fuenteRois).toBe('simulada');
  });

  it('clasifica cada toma (P/C, simetría) e informa umbral y categoría', async () => {
    const r = await predictor.predict({ patient: basePatient(), study, images: [] });
    expect(r.categoria).toBe(categoryFor(r.probabilidad));
    expect(r.umbral).toBe(1);
    expect(r.grupo).toBe(thermalGroup(r.rois, 1).grupo);
    expect(r.grupoToma1).toBe(thermalGroup(r.roisToma1, 1).grupo);
    expect(r.factores.map((f) => f.key)).toEqual(
      expect.arrayContaining(['tabaquismo', 'insulinorequiriente', 'delta_dedo_mayor', 'evolucion', 'anios_dm']),
    );
  });

  it('usa las ROIs provistas (hints) y la probabilidad aumenta si la asimetría empeora', async () => {
    const flat = ROIS.map(({ key }) => ({
      roi: key,
      avgDer: 29,
      avgIzq: 29,
      maxDer: 30,
      maxIzq: 30,
      minDer: 28,
      minIzq: 28,
      deltaT: 0,
    }));
    const worse = flat.map((r) => (r.roi === 'dedo_mayor' ? { ...r, avgDer: 30.6, deltaT: 1.6 } : r));
    const stable = await predictor.predict({ patient: basePatient(), study, hints: { toma1: flat, toma2: flat } });
    const worsening = await predictor.predict({ patient: basePatient(), study, hints: { toma1: flat, toma2: worse } });
    expect(stable.fuenteRois).toBe('imagen');
    expect(worsening.grupo).toBe('P');
    expect(worsening.grupoToma1).toBe('C');
    expect(worsening.probabilidad).toBeGreaterThan(stable.probabilidad);
    const result = new AnalysisResult(worsening);
    expect(result.roisQueEmpeoran.map((e) => e.roi)).toEqual(['dedo_mayor']);
    expect(result.maxEmpeoramiento).toBeCloseTo(1.6, 1);
  });

  it('calcula las ROIs a partir de archivos IS2 cuando se suben ambas tomas en ese formato', async () => {
    const images = [
      { slot: 'toma1', mime: 'application/x-fluke-is2', buffer: fakeIs2() },
      { slot: 'toma2', mime: 'application/x-fluke-is2', buffer: fakeIs2({ asym: 200 }) },
    ];
    const r = await predictor.predict({ patient: basePatient(), study, images });
    expect(r.fuenteRois).toBe('is2');
    const dedo1 = r.roisToma1.find((x) => x.roi === 'dedo_mayor');
    const dedo2 = r.rois.find((x) => x.roi === 'dedo_mayor');
    expect(Math.abs(dedo1.deltaT)).toBeLessThan(0.3);
    expect(dedo2.deltaT).toBeGreaterThan(1); // pie derecho más caliente en la toma 2
  });

  it('asigna mayor probabilidad a un perfil de alto riesgo clínico', async () => {
    const low = await predictor.predict({ patient: basePatient({ aniosEvolucionDm: 2 }), study });
    const high = await predictor.predict({
      patient: basePatient({
        aniosEvolucionDm: 25,
        tabaquismo: true,
        insulinorequiriente: true,
        neuropatia: true,
        neuropatiaPuntaje: 8,
        ulceraPreviaDer: true,
      }),
      study,
    });
    expect(high.probabilidad).toBeGreaterThan(low.probabilidad);
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
