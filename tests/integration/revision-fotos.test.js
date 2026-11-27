'use strict';

const request = require('supertest');
const { makeApp, loginAs, csrfFrom } = require('../helpers/agent');

describe('Revisión manual de las fotos del estudio', () => {
  let app;
  let container;
  let study;
  let ajeno;
  beforeAll(async () => {
    ({ app, container } = makeApp());
    await container.ready;
    const medico = await container.repos.users.findByEmail('medico@demo.com');
    [study] = await container.repos.studies.listByMedico(medico.id);
    const otro = await container.repos.users.findByEmail('medico2@demo.com');
    [ajeno] = await container.repos.studies.listByMedico(otro.id);
  });

  const url = (id = study.id, toma = 1, rep = 1) => `/medico/estudios/${id}/visor/${toma}/${rep}/revision`;

  it('la página del estudio muestra el bloque de revisión por foto y el contador', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    const res = await agent.get(`/medico/estudios/${study.id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Revisión de las fotos');
    expect(res.text).toContain(`action="${url()}"`);
    expect(res.text).toContain(`action="${url(study.id, 2, 1)}"`);
    expect(res.text).toMatch(/value="aprobado"/);
    expect(res.text).toMatch(/value="rechazado"/);
    expect(res.text).toMatch(/value="pendiente"[^>]*checked/);
    expect(res.text).toContain('Falta revisar');
    expect(res.text).toMatch(/Fotos: <span[^>]*>2 por revisar</);
  });

  it('el médico tratante guarda la revisión y persiste al recargar', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    const csrf = await csrfFrom(agent, `/medico/estudios/${study.id}`);
    const res = await agent
      .post(url())
      .type('form')
      .send({ _csrf: csrf, estado: 'rechazado', comentario: 'Pie fuera de foco' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/medico/estudios/${study.id}#revision-t1-r1`);
    const page = await agent.get(`/medico/estudios/${study.id}`);
    expect(page.text).toContain('Pie fuera de foco');
    expect(page.text).toMatch(/value="rechazado"[^>]*checked/);
    expect(page.text).toMatch(/Guardado por/);
    expect(page.text).toMatch(/Fotos: <span[^>]*>1 rechazada · 1 por revisar</);
  });

  it('con Accept: application/json responde la revisión y el resumen (mejora progresiva)', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    const csrf = await csrfFrom(agent, `/medico/estudios/${study.id}`);
    const res = await agent
      .post(url(study.id, 2, 1))
      .set('Accept', 'application/json')
      .set('X-CSRF-Token', csrf)
      .type('form')
      .send({ estado: 'aprobado', comentario: '' });
    expect(res.status).toBe(200);
    expect(res.body.revision).toMatchObject({ toma: 2, replica: 1, estado: 'aprobado', etiqueta: 'Aprobado' });
    expect(res.body.revision.guardado).toMatch(/^Guardado por /);
    expect(res.body.resumen).toMatchObject({ total: 2, aprobado: 1 });
    expect(typeof res.body.resumenTexto).toBe('string');
  });

  it('sin token CSRF se rechaza', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    const res = await agent.post(url()).type('form').send({ estado: 'aprobado' });
    expect(res.status).toBe(403);
  });

  it('valida el estado y el largo del comentario', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    const csrf = await csrfFrom(agent, `/medico/estudios/${study.id}`);
    const bad = await agent.post(url()).type('form').send({ _csrf: csrf, estado: 'quizas' });
    expect([303, 422]).toContain(bad.status);
    const largo = await agent
      .post(url())
      .set('Accept', 'application/json')
      .type('form')
      .send({ _csrf: csrf, estado: 'aprobado', comentario: 'x'.repeat(1001) });
    expect(largo.status).toBe(422);
    const rows = await container.repos.imageReviews.listByStudy(study.id);
    expect(rows.every((r) => r.estado !== 'quizas' && r.comentario.length <= 1000)).toBe(true);
  });

  it('una foto inexistente da 404', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    const csrf = await csrfFrom(agent, `/medico/estudios/${study.id}`);
    const res = await agent
      .post(url(study.id, 1, 3))
      .type('form')
      .send({ _csrf: csrf, estado: 'aprobado' });
    expect(res.status).toBe(404);
  });

  it('control de acceso: anónimo, paciente, administrador y otro médico', async () => {
    const anon = await request(app).post(url()).type('form').send({ estado: 'aprobado' });
    expect([302, 403]).toContain(anon.status);

    for (const email of ['paciente@demo.com', 'admin@demo.com']) {
      const agent = await loginAs(app, email);
      const csrf = await csrfFrom(agent, '/cuenta/password');
      const res = await agent.post(url()).type('form').send({ _csrf: csrf, estado: 'aprobado' });
      expect(res.status).toBe(403);
    }

    const agent = await loginAs(app, 'medico@demo.com');
    const csrf = await csrfFrom(agent, `/medico/estudios/${study.id}`);
    const res = await agent.post(url(ajeno.id)).type('form').send({ _csrf: csrf, estado: 'aprobado' });
    expect(res.status).toBe(403);
    expect(await container.repos.imageReviews.listByStudy(ajeno.id)).toEqual([]);
  });

  it('el paciente no ve el bloque de revisión en su estudio', async () => {
    const paciente = await container.repos.users.findByEmail('paciente@demo.com');
    const patient = await container.repos.patients.findByUserId(paciente.id);
    const [propio] = await container.repos.studies.listByPatient(patient.id);
    const agent = await loginAs(app, 'paciente@demo.com');
    const res = await agent.get(`/paciente/estudios/${propio.id}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Revisión de las fotos');
    expect(res.text).not.toContain('/revision"');
  });
});
