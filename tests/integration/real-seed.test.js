'use strict';

/**
 * Carga local de pacientes reales (SEED=real) probada con un dataset
 * SINTÉTICO en una carpeta temporal: no usa datos reales.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeApp, loginAs } = require('../helpers/agent');
const { fakeIs2 } = require('../helpers/is2');
const { analyzeIs2Pointwise } = require('../../src/imaging/pointwise');
const { encodePng } = require('../../src/imaging/png');

function syntheticDataset(dir) {
  fs.mkdirSync(path.join(dir, 'img'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'img', 'PHC901-toma1.png'), encodePng(2, 2, Buffer.alloc(12, 200)));
  const g1 = analyzeIs2Pointwise(fakeIs2());
  const g2 = analyzeIs2Pointwise(fakeIs2({ asym: 200 }));
  const toma = (k, g, fecha) => ({
    toma: k,
    ok: true,
    fecha,
    replicas: 3,
    validas: 3,
    imagen: `img/PHC90${k === 1 ? 1 : 2}-toma${k}.png`,
    ...g,
  });
  const paciente = (codigo, tomas, clinica = {}) => ({
    codigo,
    centro: 'Hospital Córdoba',
    identidad: { nombre: 'Prueba Sintética', dni: null, telefono: null },
    fechaToma1Planilla: null,
    clinica: { edad: 60, sexo: 'F', tipoDm: 'II', hba1c: 8, noValido: false, ...clinica },
    ana: null,
    tomas,
  });
  const dataset = {
    pacientes: [
      paciente('P.HC901', [toma(1, g1, '2026-08-01T12:00:00.000Z')]),
      paciente('P.HC902', [toma(1, g1, '2026-08-02T12:00:00.000Z'), toma(2, g2, '2018-11-10T12:00:00.000Z')]),
      // La planilla marca que este paciente no dio su consentimiento: nunca se carga.
      paciente('P.HC903', [toma(1, g1, '2026-08-03T12:00:00.000Z')], { observaciones: 'Paciente sin consentimiento' }),
    ],
  };
  fs.writeFileSync(path.join(dir, 'dataset.json'), JSON.stringify(dataset));
}

describe('SEED=real (datos locales precalculados)', () => {
  let tmp;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termopie-real-'));
    syntheticDataset(tmp);
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('sin la carpeta local usa la semilla de demostración', async () => {
    const { container } = makeApp({ SEED: 'real', REAL_DATA_DIR: path.join(tmp, 'no-existe') });
    await container.ready;
    expect(container.seedMode).toBe('demo');
    expect(await container.repos.patients.findByCodigo('DEMO-001')).toBeTruthy();
  });

  it('carga los pacientes del dataset, sin pacientes demo y conservando las cuentas del personal', async () => {
    const { app, container } = makeApp({ SEED: 'real', REAL_DATA_DIR: tmp });
    await container.ready;
    expect(container.seedMode).toBe('real');
    expect(await container.repos.patients.findByCodigo('DEMO-001')).toBeFalsy();
    expect(await container.repos.patients.findByCodigo('P.HC903')).toBeFalsy();
    expect(await container.repos.users.findByEmail('phc903@pacientes.local')).toBeFalsy();
    const solo = await container.repos.patients.findByCodigo('P.HC901');
    const [s1] = await container.repos.studies.listByPatient(solo.id);
    const a1 = await container.repos.analyses.findByStudyId(s1.id);
    expect(a1.puntual.tieneToma2).toBe(false);
    expect(s1.image('toma2')).toBeNull();

    // Fecha de cámara no confiable (año < 2020): se estima y se avisa en las notas.
    const dos = await container.repos.patients.findByCodigo('P.HC902');
    const [s2] = await container.repos.studies.listByPatient(dos.id);
    expect(new Date(s2.fechaHora).getFullYear()).toBe(2026);
    expect(s2.notasMedico).toMatch(/estimada/);

    const medico = await loginAs(app, 'medico@demo.com');
    const page = await medico.get(`/medico/estudios/${s1.id}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Sin toma 2');
    const img = await medico.get(`/media/estudios/${s1.id}/toma1`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
  });

  it('con opciones de Supabase: personal existente, pacientes sin acceso, imágenes propias e idempotencia', async () => {
    const { buildConfig } = require('../../src/config');
    const { createDataLayer } = require('../../src/repositories/RepositoryFactory');
    const { createPredictor } = require('../../src/services/predictors/PredictorFactory');
    const { seedRealData, loadRealDataset } = require('../../src/seed/realData');
    const { patientEmail } = require('../../scripts/seed-supabase-real');
    const { repos } = createDataLayer(buildConfig({ NODE_ENV: 'test', DATA_DRIVER: 'memory' }));
    const predictor = createPredictor('riesgo-bibliografia', { riesgoModelo: 'bibliografia' });
    const medico = await repos.users.create({ id: 'm-1', email: 'medico@demo.com', role: 'medico', nombre: 'M' });
    const saved = [];
    const identities = [];
    const options = {
      dataset: loadRealDataset(tmp),
      dir: tmp,
      staff: { medico },
      createIdentity: async (email) => {
        identities.push(email);
        return `id-${identities.length}`;
      },
      patientAccount: { email: patientEmail, activo: false },
      saveImage: async ({ patient, studyId, slot }) => {
        saved.push(slot);
        return { slot, storagePath: `${patient.id}/${studyId}/${slot}.png`, mime: 'image/png', size: 1 };
      },
      skipExisting: true,
    };
    const first = await seedRealData({ repos, predictor }, options);
    expect(first.resumen).toMatchObject({ pacientes: 2, estudios: 2, excluidos: 1, existentes: 0, imagenes: 3 });
    expect(saved).toEqual(['toma1', 'toma1', 'toma2']);
    // Sin cuentas demo ni correos locales: el perfil del paciente existe pero está desactivado.
    expect(identities).toEqual(['phc901@sin-acceso.invalid', 'phc902@sin-acceso.invalid']);
    expect(await repos.users.findByEmail('phc901@pacientes.local')).toBeFalsy();
    expect(await repos.users.findByEmail('paciente@demo.com')).toBeFalsy();
    const perfil = await repos.users.findByEmail('phc901@sin-acceso.invalid');
    expect(perfil.activo).toBe(false);
    const p1 = await repos.patients.findByCodigo('P.HC901');
    expect(p1.medicoId).toBe('m-1');
    const [s1] = await repos.studies.listByPatient(p1.id);
    expect(s1.image('toma1').storagePath).toBe(`${p1.id}/${s1.id}/toma1.png`);

    // Segunda corrida: no duplica nada.
    const second = await seedRealData({ repos, predictor }, options);
    expect(second.resumen).toMatchObject({ pacientes: 2, estudios: 2, existentes: 2, imagenes: 0 });
    expect(identities).toHaveLength(2);
    expect(await repos.studies.listByPatient(p1.id)).toHaveLength(1);
  });
});
