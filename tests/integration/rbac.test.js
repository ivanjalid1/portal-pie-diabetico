'use strict';

const request = require('supertest');
const { makeApp, loginAs } = require('../helpers/agent');

describe('Control de acceso por rol (RBAC)', () => {
  let app;
  let container;
  beforeAll(async () => {
    ({ app, container } = makeApp());
    await container.ready;
  });

  it('un anónimo es redirigido al login', async () => {
    for (const url of ['/admin', '/medico', '/paciente', '/medico/pacientes']) {
      const res = await request(app).get(url);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^\/login\?next=/);
    }
  });

  it('el paciente no accede a secciones de médico ni de administración', async () => {
    const agent = await loginAs(app, 'paciente@demo.com');
    expect((await agent.get('/medico')).status).toBe(403);
    expect((await agent.get('/medico/pacientes')).status).toBe(403);
    expect((await agent.get('/admin')).status).toBe(403);
  });

  it('el médico no accede a la administración ni al portal del paciente', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    expect((await agent.get('/admin/usuarios')).status).toBe(403);
    expect((await agent.get('/paciente')).status).toBe(403);
  });

  it('el administrador no accede a datos clínicos', async () => {
    const agent = await loginAs(app, 'admin@demo.com');
    expect((await agent.get('/medico/pacientes')).status).toBe(403);
    const medico = await container.repos.users.findByEmail('medico@demo.com');
    const [study] = await container.repos.studies.listByMedico(medico.id);
    expect((await agent.get(`/media/estudios/${study.id}/toma1`)).status).toBe(403);
  });

  it('un médico no ve pacientes ni estudios de otro médico (control por objeto)', async () => {
    const otro = await container.repos.users.findByEmail('medico2@demo.com');
    const [ajeno] = await container.repos.patients.listByMedico(otro.id);
    const [estudioAjeno] = await container.repos.studies.listByMedico(otro.id);
    const agent = await loginAs(app, 'medico@demo.com');
    expect((await agent.get(`/medico/pacientes/${ajeno.id}`)).status).toBe(403);
    expect((await agent.get(`/medico/estudios/${estudioAjeno.id}`)).status).toBe(403);
  });

  it('un paciente sólo ve sus propios estudios', async () => {
    const otro = await container.repos.patients.findByCodigo('DEMO-002');
    const [ajeno] = await container.repos.studies.listByPatient(otro.id);
    const agent = await loginAs(app, 'paciente@demo.com');
    expect((await agent.get(`/paciente/estudios/${ajeno.id}`)).status).toBe(404);
    expect((await agent.get(`/media/estudios/${ajeno.id}/toma1`)).status).toBe(403);
  });
});
