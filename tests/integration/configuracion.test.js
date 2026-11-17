'use strict';

const request = require('supertest');
const { makeApp, loginAs, csrfFrom } = require('../helpers/agent');
const { DEFAULTS, settingsSchema, analysisParams } = require('../../src/config/settings');
const { ValidationError } = require('../../src/utils/errors');
const { EVENTS } = require('../../src/utils/eventBus');

const form = (over = {}) => ({ ...DEFAULTS, ...over });

describe('Configuración de los parámetros del análisis', () => {
  describe('SettingsService', () => {
    let container;
    let svc;
    beforeAll(async () => {
      ({ container } = makeApp());
      await container.ready;
      svc = container.services.settingsService;
    });

    it('arranca con los valores por defecto documentados', async () => {
      const v = await svc.get();
      expect(v.umbralAsimetria).toBe(1);
      expect(v.corteSimetria).toBe(1);
      expect(v.referenciaBibliografica).toBe(2.2);
      expect(v.cambioRelevante).toBe(0.3);
      expect([v.corteModerado, v.corteAlto]).toEqual([50, 70]);
      expect(v.horizonteSemanas).toBe(6);
      expect([v.diasEntreTomas, v.diasControl]).toEqual([30, 42]);
      expect(v.paletaDefecto).toBe('alto_contraste');
    });

    it('valida rangos, coma decimal y que el corte moderado sea menor que el alto', () => {
      expect(svc.validate(form({ umbralAsimetria: '2,2' })).umbralAsimetria).toBe(2.2);
      expect(() => svc.validate(form({ corteModerado: 80, corteAlto: 70 }))).toThrow(ValidationError);
      try {
        svc.validate(form({ corteModerado: '80', umbralAsimetria: '9', tempAmbienteMin: '25' }));
      } catch (err) {
        expect(Object.keys(err.fields)).toEqual(
          expect.arrayContaining(['corteAlto', 'umbralAsimetria', 'tempAmbienteMax']),
        );
      }
      expect(settingsSchema.safeParse(form({ paletaDefecto: 'arcoiris' })).success).toBe(false);
      expect(settingsSchema.safeParse(form({ tituloImagen1: 'x' })).success).toBe(false);
    });

    it('guarda sólo los cambios y los registra en la auditoría (antes → después)', async () => {
      const medico = await container.repos.users.findByEmail('medico@demo.com');
      const published = [];
      container.events.on(EVENTS.SETTINGS_UPDATED, (p) => published.push(p));
      const changes = await svc.update(form({ umbralAsimetria: '2,2' }), { id: medico.id, email: medico.email });
      expect(changes).toEqual([expect.objectContaining({ key: 'umbralAsimetria', antes: 1, despues: 2.2 })]);
      expect((await svc.get()).umbralAsimetria).toBe(2.2);
      expect(published[0].detail).toMatch(/Umbral de asimetría por región.*1 °C → 2,2 °C/);
      await new Promise((r) => setImmediate(r));
      const [entry] = await container.repos.audit.list({ action: EVENTS.SETTINGS_UPDATED });
      expect(entry.actorEmail).toBe('medico@demo.com');
      expect(entry.detail).toContain('→ 2,2 °C');
      expect(await svc.update(form({ umbralAsimetria: 2.2 }), { id: medico.id })).toEqual([]);
    });

    it('la vista previa reclasifica los estudios existentes sin guardar', async () => {
      const base = await svc.preview({ umbralAsimetria: 1 });
      const alto = await svc.preview({ umbralAsimetria: 3 });
      expect(base.total).toBeGreaterThan(0);
      expect(alto.conAsimetria).toBeLessThanOrEqual(base.conAsimetria);
      // Análisis punto a punto: el área mínima cambia cuántos estudios quedan «con asimetría».
      const estricto = await svc.preview({ areaMinima: 50 });
      const laxo = await svc.preview({ areaMinima: 0.5 });
      expect(estricto.puntuales).toBe(estricto.total);
      expect(estricto.conAsimetriaPuntual).toBeLessThanOrEqual(laxo.conAsimetriaPuntual);
      // Mientras el modelo no esté validado, la categoría sale del hallazgo térmico (no de los cortes).
      expect(estricto.riesgo.sin_riesgo).toBe(estricto.total - estricto.conAsimetriaPuntual);
      expect((await svc.get()).corteAlto).toBe(70);
    });
  });

  describe('snapshot y recálculo', () => {
    let app;
    let container;
    let medico;
    beforeAll(async () => {
      ({ app, container } = makeApp());
      await container.ready;
      medico = await loginAs(app, 'medico@demo.com');
    });

    it('cada análisis guarda sus parámetros y los estudios previos los conservan', async () => {
      const [a0] = await container.repos.analyses.listAll();
      expect(a0.parametros).toEqual(expect.objectContaining(analysisParams(DEFAULTS)));

      const csrf = await csrfFrom(medico, '/configuracion');
      const res = await medico
        .post('/configuracion')
        .type('form')
        .send({ ...form({ umbralAsimetria: '2,2', corteSimetria: '0,5' }), _csrf: csrf });
      expect(res.status).toBe(303);

      const after = await container.repos.analyses.findByStudyId(a0.studyId);
      expect(after.parametros.umbral).toBe(1);
      const page = await medico.get(`/medico/estudios/${a0.studyId}`);
      expect(page.text).not.toMatch(/Umbral por región/);
      expect(page.text).toMatch(/Umbral por punto <strong class="num">1,0 °C/);
    });

    it('rechaza valores inválidos y muestra el error en el formulario', async () => {
      const csrf = await csrfFrom(medico, '/configuracion');
      const res = await medico
        .post('/configuracion')
        .type('form')
        .send({ ...form({ corteModerado: '75', corteAlto: '60' }), _csrf: csrf });
      expect(res.status).toBe(422);
      expect(res.text).toContain('El corte moderado debe ser menor que el corte alto.');
    });

    it('recalcula todos los estudios con la configuración vigente y lo audita', async () => {
      const csrf = await csrfFrom(medico, '/configuracion');
      const res = await medico.post('/configuracion/recalcular').type('form').send({ _csrf: csrf });
      expect(res.status).toBe(303);
      const all = await container.repos.analyses.listAll();
      expect(all.every((a) => a.umbral === 2.2 && a.parametros.corteSimetria === 0.5)).toBe(true);
      // Con 2,2 °C ninguna toma demo supera el umbral.
      expect(all.every((a) => a.grupo === 'C')).toBe(true);
      await new Promise((r) => setImmediate(r));
      const [entry] = await container.repos.audit.list({ action: EVENTS.ANALYSES_RECALCULATED });
      expect(entry.detail).toMatch(/\d+ estudios recalculados/);
      const page = await medico.get(`/medico/estudios/${all[0].studyId}`);
      expect(page.text).toMatch(/Umbral por punto <strong class="num">1,0 °C/);
      expect(page.text).not.toContain('2,2 °C');
      const csv = await medico.get('/medico/pacientes/exportar.csv');
      expect(csv.text).toContain('CORTE SIMETRIA');
    });

    it('la vista previa responde JSON sin modificar nada', async () => {
      const csrf = await csrfFrom(medico, '/configuracion');
      const res = await medico
        .post('/configuracion/vista-previa')
        .set('x-csrf-token', csrf)
        .send({ umbralAsimetria: '1' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({ total: expect.any(Number), conAsimetria: expect.any(Number) }),
      );
      expect((await container.services.settingsService.get()).umbralAsimetria).toBe(2.2);
    });

    it('los estudios nuevos usan la configuración vigente', async () => {
      const [study] = await container.repos.studies.listAll();
      const patient = await container.repos.patients.findById(study.patientId);
      const r = await container.services.analysisService.run({ study, patient, images: [] }, { id: null });
      expect(r.umbral).toBe(2.2);
      expect(r.parametros).toEqual(expect.objectContaining({ umbral: 2.2, corteSimetria: 0.5 }));
    });
  });

  describe('permisos', () => {
    let app;
    beforeAll(async () => {
      let container;
      ({ app, container } = makeApp());
      await container.ready;
    });

    it('médico/a y administrador/a acceden; el paciente recibe 403', async () => {
      expect((await (await loginAs(app, 'medico@demo.com')).get('/configuracion')).status).toBe(200);
      expect((await (await loginAs(app, 'admin@demo.com')).get('/configuracion')).status).toBe(200);
      const paciente = await loginAs(app, 'paciente@demo.com');
      expect((await paciente.get('/configuracion')).status).toBe(403);
      const csrf = await csrfFrom(paciente, '/paciente');
      expect(
        (
          await paciente
            .post('/configuracion')
            .type('form')
            .send({ ...form(), _csrf: csrf })
        ).status,
      ).toBe(403);
      expect((await paciente.post('/configuracion/recalcular').type('form').send({ _csrf: csrf })).status).toBe(403);
      const anon = await request(app).get('/configuracion');
      expect(anon.status).toBe(302);
    });

    it('el menú del médico y del administrador incluye «Configuración»', async () => {
      const res = await (await loginAs(app, 'admin@demo.com')).get('/admin');
      expect(res.text).toMatch(/href="\/configuracion" class="nav__link/);
    });
  });
});
