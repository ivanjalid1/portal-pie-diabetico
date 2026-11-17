'use strict';

const PointwisePredictor = require('../../src/services/predictors/PointwisePredictor');
const UlcerPredictor = require('../../src/services/predictors/UlcerPredictor');
const { createPredictor } = require('../../src/services/predictors/PredictorFactory');
const { loadModel } = require('../../src/services/predictors/pointwiseModel');
const { Patient, Study, AnalysisResult } = require('../../src/models');
const { fakeIs2 } = require('../helpers/is2');

const patient = new Patient({ codigo: 'P.HC999', fechaNacimiento: '1960-01-01', sexo: 'F', tipoDm: 'II' });
const study = new Study({ fechaHora: '2026-10-01T12:00:00.000Z', fechaToma1: '2026-09-01T12:00:00.000Z' });
const is2 = (slot, opts) => ({ slot, buffer: fakeIs2(opts), mime: 'application/x-fluke-is2' });

describe('PointwisePredictor (estrategia por defecto)', () => {
  it('es la estrategia por defecto e implementa UlcerPredictor', () => {
    const p = createPredictor();
    expect(p).toBeInstanceOf(PointwisePredictor);
    expect(p).toBeInstanceOf(UlcerPredictor);
    expect(p.info.id).toBe('puntual');
  });

  it('el modelo versionado sólo tiene parámetros y métricas agregadas', () => {
    const m = loadModel();
    expect(m.validacion.n).toBeGreaterThan(10);
    expect(m.validacion.auc).toBeGreaterThanOrEqual(0);
    const text = JSON.stringify(m);
    expect(text).not.toMatch(/P\.(HC|RF|VHF)\d{3}/); // sin códigos de pacientes
    expect(text).not.toMatch(/\d{7,8}/); // sin DNI ni teléfonos
  });

  it('analiza dos IS2 punto a punto y calcula la probabilidad del modelo preliminar', async () => {
    const out = await new PointwisePredictor().predict({
      patient,
      study,
      images: [is2('toma1'), is2('toma2', { asym: 200 })],
    });
    expect(out.simulado).toBe(false);
    expect(out.puntual.tieneToma2).toBe(true);
    expect(out.puntual.tomas).toHaveLength(2);
    expect(out.puntual.tomas[1].metricas.areaCalientePct).toBeGreaterThan(
      out.puntual.tomas[0].metricas.areaCalientePct,
    );
    expect(out.puntual.cambio.der).toBeTruthy();
    expect(out.probabilidad).toBeGreaterThan(0);
    expect(out.probabilidad).toBeLessThan(100);
    expect(out.puntual.modelo.n).toBeGreaterThan(0);
    expect(out.rois.map((r) => r.roi)).toContain('general');
    expect(out.roisToma1.length).toBeGreaterThan(0);
    const a = new AnalysisResult({ ...out, studyId: 's1' });
    expect(a.puntualActual.toma).toBe(2);
    expect(a.tieneToma2).toBe(true);
  });

  it('sin toma 2 analiza sólo la toma 1 («Sin toma 2»)', async () => {
    const out = await new PointwisePredictor().predict({ patient, study, images: [is2('toma1')] });
    expect(out.puntual.tieneToma2).toBe(false);
    expect(out.puntual.tomaActual).toBe(1);
    expect(out.puntual.cambio).toBeNull();
    expect(out.roisToma1).toEqual([]);
    const a = new AnalysisResult({ ...out, studyId: 's2' });
    expect(a.soloToma1).toBe(true);
    expect(a.roi('general', 1)).toBeTruthy();
    expect(a.roi('general', 2)).toBeNull();
  });

  it('mientras el modelo no discrimina (AUC < 0,7) la categoría sale del hallazgo térmico', async () => {
    const weak = { ...loadModel(), validacion: { ...loadModel().validacion, auc: 0.5 } };
    const out = await new PointwisePredictor({ model: weak }).predict({
      patient,
      study,
      images: [is2('toma1')],
      params: { areaMinima: 50 },
    });
    expect(out.puntual.categoriaPor).toBe('hallazgo_termico');
    expect(out.categoria).toBe('sin_riesgo');
  });

  it('con imágenes no radiométricas delega en el predictor simulado y lo informa', async () => {
    const out = await new PointwisePredictor().predict({
      patient,
      study,
      images: [{ slot: 'toma1', buffer: Buffer.from('x'), mime: 'image/png' }],
    });
    expect(out.puntual).toBeNull();
    expect(out.simulado).toBe(true);
  });

  it('recalcula desde las grillas guardadas (hints) con otros parámetros sin reprocesar imágenes', async () => {
    const p = new PointwisePredictor();
    const first = await p.predict({ patient, study, images: [is2('toma1', { asym: 200 })] });
    const grids = { toma1: first.puntual.tomas[0] };
    const strict = await p.predict({ patient, study, hints: { puntual: grids }, params: { umbralPixel: 4 } });
    expect(strict.puntual.umbralPixel).toBe(4);
    expect(strict.puntual.tomas[0].metricas.areaCalientePct).toBeLessThanOrEqual(
      first.puntual.tomas[0].metricas.areaCalientePct,
    );
  });
});
