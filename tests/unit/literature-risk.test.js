'use strict';

const {
  EVIDENCIA,
  bandas,
  wilson,
  iwgdfGroup,
  priorAt,
  cortesRiesgo,
  literatureRisk,
} = require('../../src/services/predictors/literatureRisk');
const { contiguousHot, persistentMap, hotspotFindings } = require('../../src/imaging/hotspot');
const { GRID } = require('../../src/imaging/pointwise');
const LiteratureRiskPredictor = require('../../src/services/predictors/LiteratureRiskPredictor');
const TrainedOutcomePredictor = require('../../src/services/predictors/TrainedOutcomePredictor');
const UlcerPredictor = require('../../src/services/predictors/UlcerPredictor');
const { createPredictor, resolvePredictorName } = require('../../src/services/predictors/PredictorFactory');
const { DEFAULT_PARAMS } = require('../../src/config/settings');
const { Patient, Study } = require('../../src/models');
const { fakeIs2 } = require('../helpers/is2');

const base = { codigo: 'P.HC999', fechaNacimiento: '1960-01-01', sexo: 'F', tipoDm: 'II' };

describe('Evidencia publicada (cifras verificadas)', () => {
  test('Frykberg 2017 y Peters y Lavery 2001', () => {
    const [u22, u32] = EVIDENCIA.frykberg2017.umbrales;
    expect([u22.sensibilidad, u22.falsosPositivos, u32.sensibilidad, u32.falsosPositivos]).toEqual([
      0.97, 0.57, 0.7, 0.32,
    ]);
    expect(EVIDENCIA.frykberg2017.doi).toBe('10.2337/dc16-2294');
    expect(EVIDENCIA.peters2001.ulceracion3Anios).toEqual([5.1, 14.3, 18.8, 55.8]);
  });

  test('LR por banda (estratos excluyentes)', () => {
    const [baja, media, alta] = bandas('graduado');
    expect(baja.lr).toBeCloseTo(0.03 / 0.43, 3);
    expect(media.lr).toBeCloseTo(0.27 / 0.25, 3);
    expect(alta.lr).toBeCloseTo(0.7 / 0.32, 3);
    for (const b of [baja, media, alta]) {
      expect(b.rango[0]).toBeLessThan(b.lr);
      expect(b.rango[1]).toBeGreaterThan(b.lr);
    }
    expect(bandas('2.2')[1].lr).toBeCloseTo(0.97 / 0.57, 3);
    expect(bandas('3.2')[0].lr).toBeCloseTo(0.3 / 0.68, 3);
  });

  test('IC de Wilson', () => {
    const [lo, hi] = wilson(0.5, 100);
    expect(lo).toBeCloseTo(0.404, 2);
    expect(hi).toBeCloseTo(0.596, 2);
  });
});

describe('Prior por grupo IWGDF', () => {
  test('estratificación con los datos de la ficha', () => {
    expect(iwgdfGroup(new Patient(base)).grupo).toBe(0);
    expect(iwgdfGroup(new Patient({ ...base, neuropatia: true })).grupo).toBe(1);
    expect(iwgdfGroup(new Patient({ ...base, isquemia: true })).grupo).toBe(1);
    expect(iwgdfGroup(new Patient({ ...base, neuropatia: true, isquemia: true })).grupo).toBe(2);
    expect(iwgdfGroup(new Patient({ ...base, ulceraPreviaIzq: true })).grupo).toBe(3);
    const sinDato = iwgdfGroup(new Patient({ ...base, neuropatiaSinDato: true }), 1);
    expect(sinDato).toMatchObject({ grupo: 1, porDefecto: true });
  });

  test('incidencia a 3 años llevada al horizonte con riesgo constante', () => {
    expect(priorAt(55.8, EVIDENCIA.peters2001.semanas)).toBeCloseTo(0.558, 6);
    const p8 = priorAt(14.3, 8);
    expect(p8).toBeCloseTo(1 - 0.857 ** (8 / 156.43), 6);
    expect(cortesRiesgo(DEFAULT_PARAMS)).toEqual({ moderado: 0.79, alto: 4.09 });
  });
});

describe('Posterior', () => {
  const p = DEFAULT_PARAMS;
  const g3 = new Patient({ ...base, ulceraPreviaDer: true, neuropatia: true });

  test('odds(posterior) = odds(prior) × LR, un solo LR', () => {
    const r = literatureRisk({ asimetria: 3.5, confirmada: 3.4, tomas: 2 }, g3, p);
    const prior = priorAt(55.8, 8);
    const esperado = ((prior / (1 - prior)) * (0.7 / 0.32)) / (1 + (prior / (1 - prior)) * (0.7 / 0.32));
    expect(r.probabilidad).toBeCloseTo(esperado * 100, 1);
    expect(r).toMatchObject({ grupoIwgdf: 3, persistente: true, categoria: 'alto' });
    expect(r.banda.key).toBe('alta');
    expect(r.rango[0]).toBeLessThan(r.probabilidad);
    expect(r.rango[1]).toBeGreaterThan(r.probabilidad);
  });

  test('sin asimetría el riesgo baja por debajo del prior; la banda ordena el riesgo', () => {
    const g1 = new Patient({ ...base, neuropatia: true });
    const baja = literatureRisk({ asimetria: 1, confirmada: 1, tomas: 2 }, g1, p);
    const media = literatureRisk({ asimetria: 2.5, confirmada: 2.5, tomas: 2 }, g1, p);
    const alta = literatureRisk({ asimetria: 3.6, confirmada: 3.6, tomas: 2 }, g1, p);
    expect(baja.probabilidad).toBeLessThan(baja.prior);
    expect(baja.probabilidad).toBeLessThan(media.probabilidad);
    expect(media.probabilidad).toBeLessThan(alta.probabilidad);
  });

  test('sin confirmación por la otra toma el rango se amplía hacia abajo', () => {
    const conf = literatureRisk({ asimetria: 3.6, confirmada: 3.5, tomas: 2 }, g3, p);
    const noConf = literatureRisk({ asimetria: 3.6, confirmada: 0.5, tomas: 2 }, g3, p);
    const una = literatureRisk({ asimetria: 3.6, confirmada: null, tomas: 1 }, g3, p);
    expect(noConf.probabilidad).toBe(conf.probabilidad);
    expect(noConf.persistente).toBe(false);
    expect(noConf.rango[0]).toBeLessThan(conf.rango[0]);
    expect(una.rango[0]).toBe(noConf.rango[0]);
  });
});

describe('Zona caliente contigua y persistencia', () => {
  const blank = () => new Float32Array(GRID.w * GRID.h).fill(0);

  test('un píxel aislado no cuenta; una zona contigua sí', () => {
    const m = blank();
    m[50 * GRID.w + 20] = 5; // aislado
    expect(contiguousHot(m, { umbral: 1 }).asimetria).toBe(0);
    for (let r = 10; r < 18; r += 1) for (let c = 10; c < 16; c += 1) m[r * GRID.w + c] = 2.5;
    const z = contiguousHot(m, { umbral: 1 });
    expect(z.asimetria).toBe(2.5);
    expect(z.zona).toBe('dedos');
    expect(z.pieMasCaliente).toBe('izquierdo');
  });

  test('persistente: menor |ΔT| si el mismo pie está más caliente en ambas tomas', () => {
    const a = Float32Array.from([2, -3, 1.5]);
    const b = Float32Array.from([3, 2, 1]);
    expect(Array.from(persistentMap(a, b))).toEqual([2, 0, 1]);
  });

  test('hallazgos por toma desde grillas', () => {
    const izq = new Float32Array(GRID.w * GRID.h).fill(30);
    const der = new Float32Array(GRID.w * GRID.h).fill(30);
    for (let r = 30; r < 45; r += 1) for (let c = 5; c < 20; c += 1) izq[r * GRID.w + c] = 33;
    const f = hotspotFindings(
      [
        { toma: 1, izq, der },
        { toma: 2, izq, der },
      ],
      { umbral: 1 },
    );
    expect(f.porToma[1].asimetria).toBeCloseTo(3, 1);
    expect(f.persistente.asimetria).toBeCloseTo(3, 1);
  });
});

describe('LiteratureRiskPredictor (estrategia por defecto)', () => {
  const study = new Study({ fechaHora: '2026-10-01T12:00:00.000Z', fechaToma1: '2026-09-01T12:00:00.000Z' });
  const is2 = (slot, opts) => ({ slot, buffer: fakeIs2(opts), mime: 'application/x-fluke-is2' });

  test('es la estrategia por defecto', () => {
    const p = createPredictor();
    expect(p).toBeInstanceOf(LiteratureRiskPredictor);
    expect(p).toBeInstanceOf(UlcerPredictor);
    expect(p.info.id).toBe('riesgo-bibliografia');
  });

  test('da el riesgo de úlcera con rango, horizonte y grupo IWGDF', async () => {
    const out = await new LiteratureRiskPredictor().predict({
      patient: new Patient({ ...base, neuropatia: true }),
      study,
      images: [is2('toma1'), is2('toma2', { asym: 200 })],
      params: DEFAULT_PARAMS,
    });
    const r = out.puntual.riesgo;
    expect(out.predictorVersion).toBe('riesgo-bibliografia-v1');
    expect(out.probabilidad).toBe(r.probabilidad);
    expect(r.grupoIwgdf).toBe(1);
    expect(r.horizonteSemanas).toBe(8);
    expect(r.rango[0]).toBeLessThanOrEqual(r.probabilidad);
    expect(r.rango[1]).toBeGreaterThanOrEqual(r.probabilidad);
    expect(out.puntual.categoriaPor).toBe('riesgo_bibliografia');
    expect(out.puntual.tomas.every((t) => t.riesgo && Number.isFinite(t.riesgo.probabilidad))).toBe(true);
    expect(out.puntual.patronDm).toBeTruthy(); // queda como dato secundario
  });
});

describe('Cambio automático al modelo entrenado', () => {
  const valido = {
    version: 'lesion-logreg-v1',
    intercepto: 0,
    features: [{ key: 'p95Abs', media: 1, desvio: 1, imputacion: 1, coef: 1 }],
    validacion: { n: 30, positivos: 12, auc: 0.78, aucIC95: [0.62, 0.9] },
  };

  test('sólo con un modelo validado (≥ 10 lesiones y ≥ 10 sin lesión, AUC ≥ 0,7)', () => {
    const conV = (v) => ({ ...valido, validacion: { ...valido.validacion, ...v } });
    expect(TrainedOutcomePredictor.isValidated(valido)).toBe(true);
    expect(TrainedOutcomePredictor.isValidated(conV({ positivos: 9 }))).toBe(false);
    expect(TrainedOutcomePredictor.isValidated(conV({ aucIC95: [0.45, 0.9] }))).toBe(false);
    expect(TrainedOutcomePredictor.isValidated(null)).toBe(false);
    expect(resolvePredictorName('riesgo-bibliografia', { outcomeModel: valido })).toBe('riesgo-entrenado');
    expect(resolvePredictorName('riesgo-bibliografia', { outcomeModel: null })).toBe('riesgo-bibliografia');
    expect(resolvePredictorName('riesgo-bibliografia', { modo: 'bibliografia', outcomeModel: valido })).toBe(
      'riesgo-bibliografia',
    );
    expect(resolvePredictorName('puntual', { outcomeModel: valido })).toBe('puntual');
  });

  test('con el modelo validado la probabilidad sale del modelo y el riesgo bibliográfico queda en el detalle', async () => {
    const study = new Study({ fechaHora: '2026-10-01T12:00:00.000Z', fechaToma1: '2026-09-01T12:00:00.000Z' });
    const out = await new TrainedOutcomePredictor({ outcomeModel: valido }).predict({
      patient: new Patient(base),
      study,
      images: [{ slot: 'toma1', buffer: fakeIs2(), mime: 'application/x-fluke-is2' }],
      params: DEFAULT_PARAMS,
    });
    expect(out.puntual.categoriaPor).toBe('modelo_entrenado');
    expect(out.probabilidad).toBe(out.puntual.riesgoEntrenado.probabilidad);
    expect(out.puntual.riesgo).toBeTruthy();
  });
});
