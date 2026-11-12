'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { makeApp, loginAs, csrfFrom, extractCsrf } = require('../helpers/agent');
const { fakeIs2 } = require('../helpers/is2');

const DEMO = path.join(__dirname, '..', '..', 'public', 'demo');
const thermal = fs.readFileSync(path.join(DEMO, 'par-05-toma1.png'));
const visible = fs.readFileSync(path.join(DEMO, 'par-05-toma2.png'));

describe('Flujo del médico: registro de paciente → estudio → resultado → paciente', () => {
  let app;
  let container;
  beforeAll(async () => {
    ({ app, container } = makeApp());
    await container.ready;
  });

  it('registra un paciente nuevo y muestra la contraseña temporal una sola vez', async () => {
    const medico = await loginAs(app, 'medico@demo.com');
    const csrf = await csrfFrom(medico, '/medico/pacientes/nuevo');
    const res = await medico.post('/medico/pacientes').type('form').send({
      _csrf: csrf,
      nombre: 'Julieta',
      apellido: 'Rivas',
      email: 'julieta.rivas.demo@gmail.com',
      centro: 'Hospital Córdoba',
      fechaNacimiento: '1975-04-12',
      sexo: 'F',
      tipoDm: 'II',
      aniosEvolucionDm: '7,5',
      tabaquismo: 'no',
      consentimientoFirmado: 'on',
      consentimientoFecha: '2026-10-01',
    });
    expect(res.status).toBe(201);
    expect(res.text).toContain('Credenciales de acceso');
    expect(res.text).toContain('julieta.rivas.demo@gmail.com');
    const p = await container.repos.users.findByEmail('julieta.rivas.demo@gmail.com');
    expect(p.mustChangePassword).toBe(true);
  });

  it('vuelve al formulario con errores si faltan datos', async () => {
    const medico = await loginAs(app, 'medico@demo.com');
    const csrf = await csrfFrom(medico, '/medico/pacientes/nuevo');
    const res = await medico.post('/medico/pacientes').type('form').send({ _csrf: csrf, nombre: 'X' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/medico/pacientes/nuevo');
    const form = await medico.get('/medico/pacientes/nuevo');
    expect(form.text).toContain('Revisá los campos marcados');
  });

  it('carga un estudio con 2 imágenes, analiza, publica y el paciente lo ve', async () => {
    const medico = await loginAs(app, 'medico@demo.com');
    const ondina = await container.repos.patients.findByCodigo('DEMO-001');
    const wizard = await medico.get(`/medico/estudios/nuevo?paciente=${ondina.id}`);
    expect(wizard.status).toBe(200);
    const csrf = extractCsrf(wizard.text);

    const res = await medico
      .post('/medico/estudios')
      .field('_csrf', csrf)
      .field('patientId', ondina.id)
      .field('fechaToma1', '2026-10-10')
      .field('fechaHora', '2026-11-10T09:30')
      .field('centro', 'Hospital Córdoba')
      .field('tempAmbiente', '22,8')
      .field('humedadRelativa', '58')
      .field('distanciaCm', '80')
      .field('emisividad', '0,98')
      .field('rangoMin', '24')
      .field('rangoMax', '35')
      .field('paleta', 'Ironbow')
      .field('tiempoEstabilizacionMin', '15')
      .field('fondo', 'Tela')
      .field('valida', 'si')
      .field('checklist', 'sin_calzado')
      .field('checklist', 'decubito')
      .field('consentimientoVerificado', 'on')
      .attach('toma1', thermal, { filename: 'IR_0001.png', contentType: 'image/png' })
      .attach('toma2', visible, { filename: 'VIS_0001.png', contentType: 'image/png' });

    expect(res.status).toBe(303);
    const location = res.headers.location;
    expect(location).toMatch(/^\/medico\/estudios\/[0-9a-f-]{36}$/);
    const studyId = location.split('/').pop();

    const result = await medico.get(location);
    expect(result.status).toBe(200);
    expect(result.text).toContain('Probabilidad de úlcera');
    expect(result.text).toContain('Umbral de asimetría');
    expect(result.text).toContain('Evolución de la asimetría');
    expect(result.text).toContain('Resultado simulado');

    // La imagen subida se sirve con control de acceso.
    const img = await medico.get(`/media/estudios/${studyId}/toma1`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');

    // El paciente ve el estudio pero no el resultado hasta que se publica.
    const paciente = await loginAs(app, 'paciente@demo.com');
    let detail = await paciente.get(`/paciente/estudios/${studyId}`);
    expect(detail.text).toContain('todavía está revisando');

    const pubCsrf = extractCsrf(result.text);
    const pub = await medico
      .post(`/medico/estudios/${studyId}/publicacion`)
      .type('form')
      .send({ _csrf: pubCsrf, publicado: 'on' });
    expect(pub.status).toBe(303);

    detail = await paciente.get(`/paciente/estudios/${studyId}`);
    expect(detail.text).not.toContain('todavía está revisando');
    expect(detail.text).not.toContain('AUC'); // sin métricas crudas del modelo
    expect((await paciente.get(`/media/estudios/${studyId}/toma2`)).status).toBe(200);

    // Exportación del informe y auditoría.
    expect((await medico.get(`/medico/estudios/${studyId}/informe`)).status).toBe(200);
    const actions = (await container.repos.audit.list({ limit: 50 })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['study.created', 'analysis.completed', 'result.published']));
  });

  it('rechaza un archivo que no es imagen aunque tenga extensión .png', async () => {
    const medico = await loginAs(app, 'medico@demo.com');
    const ondina = await container.repos.patients.findByCodigo('DEMO-001');
    const csrf = await csrfFrom(medico, `/medico/estudios/nuevo?paciente=${ondina.id}`);
    const res = await medico
      .post('/medico/estudios')
      .field('_csrf', csrf)
      .field('patientId', ondina.id)
      .field('fechaToma1', '2026-10-10')
      .field('fechaHora', '2026-11-10T09:30')
      .field('centro', 'Hospital Córdoba')
      .field('tempAmbiente', '22')
      .field('humedadRelativa', '50')
      .field('distanciaCm', '80')
      .field('emisividad', '0,98')
      .field('rangoMin', '24')
      .field('rangoMax', '35')
      .field('paleta', 'Ironbow')
      .field('tiempoEstabilizacionMin', '15')
      .field('fondo', 'Cartulina')
      .field('valida', 'si')
      .field('consentimientoVerificado', 'on')
      .attach('toma1', Buffer.from('<script>alert(1)</script>'), { filename: 'x.png', contentType: 'image/png' })
      .attach('toma2', visible, { filename: 'v.png', contentType: 'image/png' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toContain('/medico/estudios/nuevo');
  });

  it('genera la vista previa de un IS2 en el servidor (y sólo para IS2)', async () => {
    const medico = await loginAs(app, 'medico@demo.com');
    const csrf = await csrfFrom(medico, '/medico/estudios/nuevo');
    const ok = await medico
      .post('/medico/estudios/vista-previa')
      .set('X-CSRF-Token', csrf)
      .attach('archivo', fakeIs2(), 'IR_00001.IS2');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    const png = await medico
      .post('/medico/estudios/vista-previa')
      .set('X-CSRF-Token', csrf)
      .attach('archivo', thermal, 'a.png');
    expect(png.status).toBe(415);
    const noCsrf = await medico.post('/medico/estudios/vista-previa').attach('archivo', fakeIs2(), 'x.IS2');
    expect(noCsrf.status).toBe(403);
  });

  it('reutiliza la toma 1 de un estudio anterior y analiza IS2 reales', async () => {
    const medico = await loginAs(app, 'medico@demo.com');
    const ondina = await container.repos.patients.findByCodigo('DEMO-001');
    const [previo] = await container.repos.studies.listByPatient(ondina.id);
    const csrf = await csrfFrom(medico, `/medico/estudios/nuevo?paciente=${ondina.id}`);
    const res = await medico
      .post('/medico/estudios')
      .field('_csrf', csrf)
      .field('patientId', ondina.id)
      .field('toma1Origen', previo.id)
      .field('fechaHora', '2026-11-11T09:30')
      .field('centro', 'Hospital Córdoba')
      .field('tempAmbiente', '22')
      .field('humedadRelativa', '50')
      .field('distanciaCm', '80')
      .field('emisividad', '0,98')
      .field('rangoMin', '24')
      .field('rangoMax', '35')
      .field('paleta', 'Ironbow')
      .field('tiempoEstabilizacionMin', '15')
      .field('fondo', 'Cartulina')
      .field('valida', 'si')
      .field('consentimientoVerificado', 'on')
      .attach('toma2', fakeIs2({ asym: 200 }), 'IR_00002.IS2');
    expect(res.status).toBe(303);
    const studyId = res.headers.location.split('/').pop();
    const study = await container.repos.studies.findById(studyId);
    expect(study.toma1OrigenStudyId).toBe(previo.id);
    expect(study.image('toma1').publicUrl || study.image('toma1').storagePath).toBeTruthy();
    expect(new Date(study.fechaToma1).getTime()).toBe(new Date(previo.fechaToma1).getTime());
    const img = await medico.get(`/media/estudios/${studyId}/toma2?vista=png`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
  });

  it('multipart sin CSRF es rechazado', async () => {
    const medico = await loginAs(app, 'medico@demo.com');
    const res = await medico.post('/medico/estudios').field('patientId', 'x').attach('toma1', thermal, 'a.png');
    expect(res.status).toBe(403);
  });

  it('el paciente con contraseña temporal debe cambiarla antes de continuar', async () => {
    const { tempPassword, user } = await container.services.userService.createAccount({
      email: 'temporal.demo@gmail.com',
      role: 'paciente',
      nombre: 'Tem',
      apellido: 'Poral',
    });
    const agent = await loginAs(app, user.email, tempPassword);
    const home = await agent.get('/paciente');
    expect(home.status).toBe(302);
    expect(home.headers.location).toBe('/cuenta/password');
    const csrf = await csrfFrom(agent, '/cuenta/password');
    const change = await agent
      .post('/cuenta/password')
      .type('form')
      .send({ _csrf: csrf, actual: tempPassword, nueva: 'NuevaClave123', confirmacion: 'NuevaClave123' });
    expect(change.status).toBe(303);
    expect((await container.repos.users.findById(user.id)).mustChangePassword).toBe(false);
  });

  it('el administrador da de alta un médico/a', async () => {
    const admin = await loginAs(app, 'admin@demo.com');
    const csrf = await csrfFrom(admin, '/admin/usuarios/nuevo-medico');
    const res = await admin.post('/admin/usuarios/medicos').type('form').send({
      _csrf: csrf,
      nombre: 'Paula',
      apellido: 'Ledesma',
      email: 'paula.ledesma@demo.com',
      matricula: 'MP 11111',
      institucion: 'Hospital Ferreyra',
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Contraseña temporal');
    const audit = await admin.get('/admin/auditoria');
    expect(audit.text).toContain('Alta de usuario');
  });

  it('exporta el CSV anonimizado', async () => {
    const medico = await loginAs(app, 'medico@demo.com');
    const res = await medico.get('/medico/pacientes/exportar.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('ID PACIENTE;EDAD;SEXO');
  });
});
