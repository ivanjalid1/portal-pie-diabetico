'use strict';

/**
 * Pruebas de extremo a extremo contra un proyecto Supabase real.
 * Se omiten salvo que se ejecute:  SUPABASE_E2E=1 npm test -- tests/supabase
 * (requiere .env con las claves y la semilla cargada: npm run seed:supabase).
 */
const fs = require('node:fs');
const path = require('node:path');
const { makeApp, loginAs, csrfFrom, extractCsrf } = require('../helpers/agent');

const run = process.env.SUPABASE_E2E === '1' ? describe : describe.skip;
const DEMO = path.join(__dirname, '..', '..', 'public', 'demo');

run('Driver supabase (nube)', () => {
  jest.setTimeout(60000);
  let app;
  let container;
  const createdEmails = [];

  beforeAll(async () => {
    ({ app, container } = makeApp({ DATA_DRIVER: 'supabase' }));
    await container.ready;
  });

  afterAll(async () => {
    // Limpieza de lo creado por la prueba.
    const { getSupabaseClients } = require('../../src/config/supabase');
    const { admin } = getSupabaseClients(container.config);
    for (const email of createdEmails) {
      const u = await container.repos.users.findByEmail(email);
      if (!u) continue;
      await admin.from('patients').delete().eq('user_id', u.id);
      await admin.auth.admin.deleteUser(u.id);
    }
  });

  it.each([
    ['admin@demo.com', '/admin', ['/admin/usuarios', '/admin/auditoria']],
    ['medico@demo.com', '/medico', ['/medico/pacientes', '/medico/controles', '/medico/estudios/nuevo']],
    ['paciente@demo.com', '/paciente', ['/paciente/estudios', '/paciente/datos']],
  ])('%s ingresa contra Supabase Auth y navega su sección', async (email, home, pages) => {
    const agent = await loginAs(app, email);
    expect(agent.lastLogin.headers.location).toBe(home);
    for (const url of [home, ...pages]) expect((await agent.get(url)).status).toBe(200);
  });

  it('rechaza credenciales inválidas', async () => {
    const agent = await loginAs(app, 'medico@demo.com', 'NoEsLaClave1');
    expect(agent.lastLogin.headers.location).toBe('/login');
  });

  it('registra paciente, sube 2 imágenes a Storage, analiza, publica y el paciente lo ve', async () => {
    const medico = await loginAs(app, 'medico@demo.com');
    const email = `e2e.${Date.now()}.demo@gmail.com`;
    createdEmails.push(email);
    let csrf = await csrfFrom(medico, '/medico/pacientes/nuevo');
    const reg = await medico.post('/medico/pacientes').type('form').send({
      _csrf: csrf,
      nombre: 'Prueba',
      apellido: 'E2E',
      email,
      centro: 'Hospital Ferreyra',
      fechaNacimiento: '1970-01-01',
      sexo: 'M',
      tipoDm: 'II',
      aniosEvolucionDm: '5',
      tabaquismo: 'no',
      consentimientoFirmado: 'on',
      consentimientoFecha: '2026-11-01',
    });
    expect(reg.status).toBe(201);
    const tempPassword = /id="cred-pass"[^>]*>([^<]+)</.exec(reg.text)[1];
    const user = await container.repos.users.findByEmail(email);
    const patient = await container.repos.patients.findByUserId(user.id);
    expect(patient.codigo).toMatch(/^P\.VHF\d{3}$/);

    const wizard = await medico.get(`/medico/estudios/nuevo?paciente=${patient.id}`);
    csrf = extractCsrf(wizard.text);
    const res = await medico
      .post('/medico/estudios')
      .field('_csrf', csrf)
      .field('patientId', patient.id)
      .field('toma', '1')
      .field('fechaHora', '2026-11-10T09:30')
      .field('centro', 'Hospital Ferreyra')
      .field('tempAmbiente', '22,5')
      .field('humedadRelativa', '55')
      .field('distanciaCm', '80')
      .field('emisividad', '0,98')
      .field('rangoMin', '24')
      .field('rangoMax', '35')
      .field('paleta', 'Ironbow')
      .field('tiempoEstabilizacionMin', '15')
      .field('fondo', 'Cartulina')
      .field('valida', 'si')
      .field('consentimientoVerificado', 'on')
      .attach('termografia', fs.readFileSync(path.join(DEMO, 'termografia-03.png')), 'IR_9.png')
      .attach('visible', fs.readFileSync(path.join(DEMO, 'visible-03.png')), 'VIS_9.png');
    expect(res.status).toBe(303);
    const studyId = res.headers.location.split('/').pop();

    const result = await medico.get(res.headers.location);
    expect(result.status).toBe(200);
    expect(result.text).toContain('Probabilidad de úlcera');
    const analysis = await container.repos.analyses.findByStudyId(studyId);
    expect(analysis.rois).toHaveLength(7);

    const img = await medico.get(`/media/estudios/${studyId}/termografia`);
    expect(img.status).toBe(302);
    expect(img.headers.location).toMatch(/supabase\.co\/storage\/v1\/object\/sign\/estudios\//);

    await medico
      .post(`/medico/estudios/${studyId}/publicacion`)
      .type('form')
      .send({ _csrf: extractCsrf(result.text), publicado: 'on' });

    const paciente = await loginAs(app, email, tempPassword);
    const pwCsrf = await csrfFrom(paciente, '/cuenta/password');
    await paciente
      .post('/cuenta/password')
      .type('form')
      .send({ _csrf: pwCsrf, actual: tempPassword, nueva: 'ClaveNueva123', confirmacion: 'ClaveNueva123' });
    const detail = await paciente.get(`/paciente/estudios/${studyId}`);
    expect(detail.status).toBe(200);
    expect(detail.text).not.toContain('todavía está revisando');
  });
});
