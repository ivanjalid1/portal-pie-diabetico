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
});
