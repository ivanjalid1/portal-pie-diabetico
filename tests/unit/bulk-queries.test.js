'use strict';

/**
 * Páginas con muchos pacientes: en producción (Vercel → Supabase) cada
 * consulta es un viaje de red, así que no se consulta una vez por estudio.
 */
const { makeApp, loginAs } = require('../helpers/agent');

describe('consultas en bloque', () => {
  let app;
  let container;
  beforeAll(async () => {
    ({ app, container } = makeApp());
    await container.ready;
  });

  it('la vista previa de la configuración no busca estudio ni paciente uno por uno', async () => {
    const { studies, patients } = container.repos;
    const findStudy = jest.spyOn(studies, 'findById');
    const findPatient = jest.spyOn(patients, 'findById');
    const out = await container.services.settingsService.preview({});
    expect(out.total).toBeGreaterThan(0);
    expect(findStudy).not.toHaveBeenCalled();
    expect(findPatient).not.toHaveBeenCalled();
    findStudy.mockRestore();
    findPatient.mockRestore();
  });

  it('el asistente de estudio arma las tomas 1 reutilizables con una sola consulta', async () => {
    const medico = await container.repos.users.findByEmail('medico@demo.com');
    const byPatient = jest.spyOn(container.repos.studies, 'listByPatient');
    const byMedico = jest.spyOn(container.repos.studies, 'listByMedico');
    const opts = await container.services.studyService.toma1OptionsByPatient(medico.id);
    const [patientId, list] = Object.entries(opts)[0];
    expect(list[0]).toEqual({ studyId: expect.any(String), fecha: expect.any(String) });
    expect(await container.services.studyService.toma1Options(patientId, medico.id)).toEqual(list);
    byPatient.mockClear();
    byMedico.mockClear();

    const agent = await loginAs(app, 'medico@demo.com');
    const res = await agent.get('/medico/estudios/nuevo');
    expect(res.status).toBe(200);
    expect(byPatient).not.toHaveBeenCalled();
    byPatient.mockRestore();
    byMedico.mockRestore();
  });
});
