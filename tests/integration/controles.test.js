'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { makeApp, loginAs, csrfFrom } = require('../helpers/agent');

const DEMO = path.join(__dirname, '..', '..', 'public', 'demo');

describe('Controles: próximos, vencidos y realizados', () => {
  let app;
  let container;
  let medico;
  beforeAll(async () => {
    ({ app, container } = makeApp());
    await container.ready;
    medico = await container.repos.users.findByEmail('medico@demo.com');
  });

  it('la semilla tiene controles realizados, vencidos y ausentes', async () => {
    const { counts } = await container.services.appointmentService.listDetailed(medico.id, { vista: 'realizados' });
    expect(counts.realizados).toBeGreaterThanOrEqual(8);
    expect(counts.vencidos).toBeGreaterThanOrEqual(1);
    expect(counts.proximos).toBeGreaterThanOrEqual(1);
    const all = await container.repos.appointments.listByMedico(medico.id);
    expect(all.some((a) => a.estado === 'ausente' && a.motivoAusencia)).toBe(true);
    expect(all.filter((a) => a.estado === 'realizado').every((a) => a.studyId && a.realizadoEn)).toBe(true);
  });

  it('muestra cada vista y filtra por riesgo', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    for (const vista of ['proximos', 'vencidos', 'realizados']) {
      const res = await agent.get(`/medico/controles?vista=${vista}`);
      expect(res.status).toBe(200);
    }
    const realizados = await agent.get('/medico/controles?vista=realizados');
    expect(realizados.text).toContain('Estudio comparativo');
    const alto = await agent.get('/medico/controles?vista=realizados&riesgo=alto');
    expect(alto.text).toContain('Alto riesgo');
    expect(alto.text).not.toContain('Sin riesgo ');
  });

  it('exporta el CSV de controles sin datos personales', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    const res = await agent.get('/medico/controles/exportar.csv?vista=realizados');
    expect(res.status).toBe(200);
    expect(res.text).toContain('ID PACIENTE;ESTADO;FECHA PROGRAMADA;FECHA REALIZADO');
    expect(res.text).not.toMatch(/@demo|gmail/);
  });

  it('registrar una ausencia exige motivo', async () => {
    const svc = container.services.appointmentService;
    const [pend] = await svc.pendingForMedico(medico.id);
    await expect(svc.setEstado(pend.id, { estado: 'ausente' }, { id: medico.id })).rejects.toThrow(/motivo/);
    const upd = await svc.setEstado(pend.id, { estado: 'ausente', motivo: 'No vino' }, { id: medico.id });
    expect(upd.estado).toBe('ausente');
  });

  it('al guardar una toma 2 el control pendiente pasa a realizado y queda vinculado', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    const rows = await container.services.patientService.listForMedico(medico.id);
    const target = rows.find((r) => r.proximoControl);
    const pendingId = target.proximoControl.id;
    const csrf = await csrfFrom(agent, `/medico/estudios/nuevo?paciente=${target.patient.id}`);
    const res = await agent
      .post('/medico/estudios')
      .field('_csrf', csrf)
      .field('patientId', target.patient.id)
      .field('fechaToma1', '2026-10-01')
      .field('fechaHora', '2026-11-05T10:00')
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
      .attach('toma1', fs.readFileSync(path.join(DEMO, 'par-01-toma1.png')), 'a.png')
      .attach('toma2', fs.readFileSync(path.join(DEMO, 'par-01-toma2.png')), 'b.png');
    expect(res.status).toBe(303);
    const studyId = res.headers.location.split('/').pop();
    const appt = await container.repos.appointments.findById(pendingId);
    expect(appt.estado).toBe('realizado');
    expect(appt.studyId).toBe(studyId);
  });

  it('el paciente ve sus controles en lenguaje simple', async () => {
    const agent = await loginAs(app, 'paciente@demo.com');
    const res = await agent.get('/paciente/controles');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Mis controles');
    expect(res.text).toContain('Asististe al control');
  });
});

describe('Robustez: la vinculación del control no rompe el alta del estudio', () => {
  it('si falla la actualización del control, el estudio igual se guarda y se analiza', async () => {
    const { app, container } = makeApp();
    await container.ready;
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    container.services.appointmentService.completeWithStudy = async () => {
      throw new Error("Could not find the 'realizado_en' column");
    };
    const medico = await container.repos.users.findByEmail('medico@demo.com');
    const [row] = await container.services.patientService.listForMedico(medico.id);
    const agent = await loginAs(app, 'medico@demo.com');
    const csrf = await csrfFrom(agent, `/medico/estudios/nuevo?paciente=${row.patient.id}`);
    const res = await agent
      .post('/medico/estudios')
      .field('_csrf', csrf)
      .field('patientId', row.patient.id)
      .field('fechaToma1', '2026-10-01')
      .field('fechaHora', '2026-11-05T10:00')
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
      .attach('toma1', fs.readFileSync(path.join(DEMO, 'par-02-toma1.png')), 'a.png')
      .attach('toma2', fs.readFileSync(path.join(DEMO, 'par-02-toma2.png')), 'b.png');
    expect(res.status).toBe(303);
    const studyId = res.headers.location.split('/').pop();
    const study = await container.repos.studies.findById(studyId);
    expect(study.estado).toBe('analizado');
    expect(await container.repos.analyses.findByStudyId(studyId)).not.toBeNull();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[controles]'));
    spy.mockRestore();
  });
});
