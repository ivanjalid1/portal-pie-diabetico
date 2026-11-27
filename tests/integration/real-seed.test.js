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
  fs.writeFileSync(path.join(dir, 'img', 'PHC902-toma2.png'), encodePng(2, 2, Buffer.alloc(12, 100)));
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
      // Excluido en la Parte 1 por la imagen: se carga y se evalúa como el resto (sólo etiqueta histórica).
      paciente(
        'P.HC904',
        [
          {
            ...toma(1, g1, '2026-08-04T12:00:00.000Z'),
            imagen: 'img/PHC901-toma1.png',
            calidadFotos: {
              replicas: 3,
              limpias: 3,
              baja: false,
              banderas: [],
              rep: 1,
              promedio: {
                n: 3,
                promedio: true,
                reps: [1, 2, 3],
                estabilidad: { areaCalienteDe: 6.2, areaCalienteMin: 20, areaCalienteMax: 32, deltaMaxDe: 0.3 },
              },
            },
          },
        ],
        { noValido: true, observaciones: 'PACIENTE NO VALIDO X IMAGEN' },
      ),
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
    // «NO VALIDO» en la planilla: estudio válido, etiqueta histórica neutra y promedio de fotos.
    const nv = await container.repos.patients.findByCodigo('P.HC904');
    const [s4] = await container.repos.studies.listByPatient(nv.id);
    expect(s4.valida).toBe(true);
    expect(s4.motivoInvalidez).toBeNull();
    const p4 = await medico.get(`/medico/estudios/${s4.id}`);
    expect(p4.status).toBe(200);
    expect(p4.text).toContain('Excluido en la tesis de Ana (imagen)');
    expect(p4.text).toContain('Promedio de 3 fotos');
    expect(p4.text).not.toContain('marcadas como no válidas');
    const f4 = await medico.get(`/medico/pacientes/${nv.id}`);
    expect(f4.text).toContain('Excluido en la tesis de Ana (imagen)');
    expect(f4.text).not.toContain('Imagen no válida');
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
    expect(first.resumen).toMatchObject({ pacientes: 3, estudios: 3, excluidos: 1, existentes: 0, imagenes: 4 });
    expect(saved).toEqual(['toma1', 'toma1', 'toma2', 'toma1']);
    // Sin cuentas demo ni correos locales: el perfil del paciente existe pero está desactivado.
    expect(identities).toEqual(['phc901@sin-acceso.invalid', 'phc902@sin-acceso.invalid', 'phc904@sin-acceso.invalid']);
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
    expect(second.resumen).toMatchObject({ pacientes: 3, estudios: 3, existentes: 3, imagenes: 0 });
    expect(identities).toHaveLength(3);
    expect(await repos.studies.listByPatient(p1.id)).toHaveLength(1);
  });

  it('--actualizar: grillas nuevas, imagen re-subida y sin la marca automática «no válido» de la carga anterior', async () => {
    const { buildConfig } = require('../../src/config');
    const { createDataLayer } = require('../../src/repositories/RepositoryFactory');
    const { createPredictor } = require('../../src/services/predictors/PredictorFactory');
    const { seedRealData, loadRealDataset } = require('../../src/seed/realData');
    const { refreshExisting, MOTIVO_NO_VALIDO_ANTERIOR } = require('../../scripts/seed-supabase-real');
    const { repos } = createDataLayer(buildConfig({ NODE_ENV: 'test', DATA_DRIVER: 'memory' }));
    const predictor = createPredictor('riesgo-bibliografia', { riesgoModelo: 'bibliografia' });
    const medico = await repos.users.create({ id: 'm-2', email: 'medico@demo.com', role: 'medico', nombre: 'M' });
    const dataset = loadRealDataset(tmp);
    let n = 0;
    await seedRealData(
      { repos, predictor },
      {
        dataset,
        dir: tmp,
        staff: { medico },
        createIdentity: async () => `id-${(n += 1)}`,
        saveImage: async ({ patient, studyId, slot }) => ({
          slot,
          storagePath: `${patient.id}/${studyId}/${slot}.png`,
          mime: 'image/png',
          size: 1,
        }),
        skipExisting: true,
      },
    );
    // Como quedó en producción con la carga anterior.
    const nv = await repos.patients.findByCodigo('P.HC904');
    const [s4] = await repos.studies.listByPatient(nv.id);
    await repos.studies.update(s4.id, { valida: false, motivoInvalidez: MOTIVO_NO_VALIDO_ANTERIOR });
    const otro = await repos.patients.findByCodigo('P.HC901');
    const [s1] = await repos.studies.listByPatient(otro.id);
    await repos.studies.update(s1.id, { valida: false, motivoInvalidez: 'Movimiento (marcado a mano)' });
    const a4 = await repos.analyses.findByStudyId(s4.id);
    await repos.analyses.update(a4.id, { puntual: { ...a4.puntual, tomas: [] } });

    const subidas = [];
    const admin = {
      storage: {
        from: () => ({
          upload: async (key) => {
            subidas.push(key);
            return { error: null };
          },
        }),
      },
    };
    const args = { repos, admin, bucket: 'estudios', predictor, dataset, dir: tmp, log: () => {} };
    const seco = await refreshExisting({ ...args, dryRun: true });
    expect(seco).toMatchObject({ estudios: 3, validados: 1 });
    expect(subidas).toEqual([]);
    expect((await repos.studies.findById(s4.id)).valida).toBe(false);

    const tot = await refreshExisting({ ...args, dryRun: false });
    expect(tot).toMatchObject({ estudios: 3, imagenes: 4, validados: 1, nuevos: 0 });
    expect(subidas).toContain(`${nv.id}/${s4.id}/toma1.png`);
    const s4b = await repos.studies.findById(s4.id);
    expect(s4b.valida).toBe(true);
    expect(s4b.motivoInvalidez).toBeNull();
    // Lo marcado a mano por el equipo no se toca.
    expect((await repos.studies.findById(s1.id)).valida).toBe(false);
    const a4b = await repos.analyses.findByStudyId(s4.id);
    expect(a4b.puntual.tomas[0].calidadFotos.promedio.n).toBe(3);
  });
});
