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
            calidadFotos: { replicas: 3, limpias: 2, baja: false, banderas: [], rep: 1, sugerida: 1, elegidaPor: null },
            // Datos de cada foto de la toma: la 2 tiene asimetría (otra grilla) y la 3 un aviso grave.
            porReplica: [
              { ...g1, rep: 1, clave: 'k1', calidad: 0.9, banderas: [], imagen: 'img/PHC901-toma1.png' },
              { ...g2, rep: 2, clave: 'k2', calidad: 0.8, banderas: [], imagen: 'img/PHC902-toma2.png' },
              { ...g1, rep: 3, clave: 'k3', calidad: 0.7, banderas: ['talon_cortado'], imagen: 'img/PHC901-toma1.png' },
            ],
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
    // «NO VALIDO» en la planilla: estudio válido, sin ninguna etiqueta visible; una foto por toma.
    const nv = await container.repos.patients.findByCodigo('P.HC904');
    const [s4] = await container.repos.studies.listByPatient(nv.id);
    expect(s4.valida).toBe(true);
    expect(s4.motivoInvalidez).toBeNull();
    const p4 = await medico.get(`/medico/estudios/${s4.id}`);
    expect(p4.status).toBe(200);
    expect(p4.text).not.toMatch(/tesis de Ana|NO VALIDO|Excluido/);
    expect(p4.text).toContain('Foto 1 de 3 · sugerida automáticamente');
    expect(p4.text).not.toContain('marcadas como no válidas');
    const f4 = await medico.get(`/medico/pacientes/${nv.id}`);
    expect(f4.text).not.toMatch(/tesis de Ana|NO VALIDO|Excluido/);
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

    // Foto 2 elegida a mano en «Revisión de fotos»: la actualización la respeta.
    await repos.tomaReviews.upsert({
      studyId: s4.id,
      toma: 1,
      replicaElegida: 2,
      estado: 'aprobado',
      comentario: '',
      revisadoPor: medico.id,
    });
    const tot = await refreshExisting({ ...args, dryRun: false });
    expect(tot).toMatchObject({ estudios: 3, imagenes: 3, replicas: 3, validados: 1, nuevos: 0, elegidasAMano: 1 });
    expect(subidas).toEqual(
      expect.arrayContaining([
        `${nv.id}/${s4.id}/toma1-r1.png`,
        `${nv.id}/${s4.id}/toma1-r2.png`,
        `${nv.id}/${s4.id}/toma1-r3.png`,
        `termica/${nv.id}/${s4.id}/replicas.json.gz`,
      ]),
    );
    expect((await repos.studies.findById(s4.id)).image('toma1').storagePath).toBe(`${nv.id}/${s4.id}/toma1-r2.png`);
    const s4b = await repos.studies.findById(s4.id);
    expect(s4b.valida).toBe(true);
    expect(s4b.motivoInvalidez).toBeNull();
    // Lo marcado a mano por el equipo no se toca.
    expect((await repos.studies.findById(s1.id)).valida).toBe(false);
    const a4b = await repos.analyses.findByStudyId(s4.id);
    expect(a4b.puntual.tomas[0].calidadFotos).toMatchObject({ rep: 2, sugerida: 1, elegidaPor: 'M' });
  });

  it('elegir otra foto de una toma vuelve a analizarla, cambia la imagen y la página lo muestra', async () => {
    const { TomaReviewService } = require('../../src/services/TomaReviewService');
    const { app, container } = makeApp({ SEED: 'real', REAL_DATA_DIR: tmp });
    await container.ready;
    const nv = await container.repos.patients.findByCodigo('P.HC904');
    const [s4] = await container.repos.studies.listByPatient(nv.id);
    const medico = await container.repos.users.findByEmail('medico@demo.com');
    const actor = { id: medico.id, email: medico.email, role: medico.role, ip: '127.0.0.1' };
    // En las pruebas no hay réplicas exportadas: el visor se simula con las 3 fotos de la toma.
    const viewerService = {
      sources: async () => [{ toma: 1, origen: 'real', reps: [1, 2, 3].map((rep) => ({ rep, mejor: rep === 1 })) }],
    };
    const { services, repos } = container;
    const svc = new TomaReviewService({
      reviews: repos.tomaReviews,
      users: repos.users,
      studyService: services.studyService,
      viewerService,
      replicaStore: services.replicaStore,
      analysisService: services.analysisService,
      studies: repos.studies,
      events: container.events,
    });
    const antes = await repos.analyses.findByStudyId(s4.id);
    expect(antes.puntual.tomas[0].calidadFotos.rep).toBe(1);

    const r2 = await svc.save(s4.id, 1, { replica: 2, estado: 'aprobado', comentario: 'Mejor encuadre' }, actor);
    expect(r2.review.replicaElegida).toBe(2);
    expect(r2.analisis).not.toBeNull();
    const despues = await repos.analyses.findByStudyId(s4.id);
    const t = despues.puntual.tomas[0];
    expect(t.calidadFotos).toMatchObject({ rep: 2, sugerida: 1, elegidaPor: medico.nombreCompleto });
    expect(t.izq + t.der === antes.puntual.tomas[0].izq + antes.puntual.tomas[0].der).toBe(false);
    expect(t.metricas.areaCalientePct).not.toBe(antes.puntual.tomas[0].metricas.areaCalientePct);
    expect((await repos.studies.findById(s4.id)).image('toma1').storagePath).toBe('real/img/PHC902-toma2.png');
    const agent = await loginAs(app, 'medico@demo.com');
    const page = await agent.get(`/medico/estudios/${s4.id}`);
    expect(page.text).toContain(`Foto 2 de 3 · elegida por ${medico.nombreCompleto}`);

    // Volver a la sugerida: mismo resultado que al principio.
    const r1 = await svc.save(s4.id, 1, { replica: 1, estado: 'pendiente', comentario: '' }, actor);
    expect(r1.review.replicaElegida).toBeNull();
    const vuelta = await repos.analyses.findByStudyId(s4.id);
    expect(vuelta.puntual.tomas[0].metricas).toEqual(antes.puntual.tomas[0].metricas);
    expect(vuelta.categoria).toBe(antes.categoria);
    expect(vuelta.puntual.tomas[0].calidadFotos.elegidaPor).toBeNull();
    expect((await repos.studies.findById(s4.id)).image('toma1').storagePath).toBe('real/img/PHC901-toma1.png');

    // La 3 tiene un aviso grave: la toma queda con calidad baja si se la elige.
    await svc.save(s4.id, 1, { replica: 3, estado: 'pendiente' }, actor);
    expect((await repos.analyses.findByStudyId(s4.id)).puntual.tomas[0].calidadFotos.baja).toBe(true);
  });

  it('corregir el contorno de la foto usada vuelve a analizar la toma; quitarlo vuelve al automático', async () => {
    const { MaskCorrectionService } = require('../../src/services/MaskCorrectionService');
    const { decodeIs2 } = require('../../src/imaging/is2');
    const { toCelsius } = require('../../src/imaging/thermogram');
    const { encodeThermal } = require('../../src/imaging/thermalArray');
    const { encodeRle, decodeRle } = require('../../src/services/MaskService');
    const { ValidationError, ForbiddenError } = require('../../src/utils/errors');
    const { container } = makeApp({ SEED: 'real', REAL_DATA_DIR: tmp });
    await container.ready;
    const { services, repos } = container;
    const nv = await repos.patients.findByCodigo('P.HC904');
    const [s4] = await repos.studies.listByPatient(nv.id);
    const medico = await repos.users.findByEmail('medico@demo.com');
    const otro = await repos.users.findByEmail('medico2@demo.com');
    const actor = (u) => ({ id: u.id, email: u.email, role: u.role, ip: '127.0.0.1' });
    // Matriz de temperaturas de la foto (la misma que vería el visor).
    const img = decodeIs2(fakeIs2());
    const T = Float32Array.from(img.data, (v) => toCelsius(v));
    const tpv = encodeThermal({ width: img.width, height: img.height, data: T });
    const viewerService = { thermal: async () => tpv };
    const svc = new MaskCorrectionService({
      corrections: repos.maskCorrections,
      files: repos.files,
      users: repos.users,
      studyService: services.studyService,
      viewerService,
      replicaStore: services.replicaStore,
      analysisService: services.analysisService,
      events: container.events,
    });
    // Contorno: dos elipses (como los pies sintéticos), recortando el talón del pie derecho.
    const lab = new Uint8Array(320 * 240);
    for (let y = 0; y < 240; y += 1)
      for (let x = 0; x < 320; x += 1) {
        if (((x - 100) / 32) ** 2 + ((y - 125) / 95) ** 2 <= 1) lab[y * 320 + x] = 1;
        if (((x - 220) / 32) ** 2 + ((y - 125) / 95) ** 2 <= 1 && y < 190) lab[y * 320 + x] = 2;
      }
    const antes = await repos.analyses.findByStudyId(s4.id);
    const ed = await svc.editor(s4.id, 1, 1, medico);
    expect(ed).toMatchObject({ toma: 1, rep: 1, corregida: null, base: 'automatica', usada: true });

    await expect(
      svc.save(s4.id, 1, 1, { rle: encodeRle(new Uint8Array(320 * 240)) }, actor(medico)),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.save(s4.id, 1, 1, { rle: 'x' }, actor(medico))).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.save(s4.id, 1, 1, { rle: encodeRle(lab) }, actor(otro))).rejects.toBeInstanceOf(ForbiddenError);

    const { correction, analisis } = await svc.save(
      s4.id,
      1,
      1,
      { rle: encodeRle(lab), origen: 'automatica' },
      actor(medico),
    );
    expect(correction).toMatchObject({ toma: 1, replica: 1, corregidoPor: medico.id, clave: null });
    expect(correction.storagePath).toBe(`mascaras/${nv.id}/${s4.id}/toma1-r1.json.gz`);
    expect(analisis).not.toBeNull();
    const t = (await repos.analyses.findByStudyId(s4.id)).puntual.tomas[0];
    expect(t.segmentacion).toBe('manual');
    expect(t.calidadFotos).toMatchObject({ rep: 1, contornoPor: medico.nombreCompleto });
    expect(t.metricas).not.toEqual(antes.puntual.tomas[0].metricas);
    const ed2 = await svc.editor(s4.id, 1, 1, medico);
    expect(ed2.base).toBe('corregida');
    expect(Array.from(decodeRle(ed2.corregida))).toEqual(Array.from(lab));
    expect(ed2.corregidoPor).toBe(medico.nombreCompleto);
    expect((await svc.byStudies([s4.id])).get(`${s4.id}:1:1`)).toMatchObject({ por: medico.nombreCompleto });

    // Una foto que no se usa: se guarda el contorno sin volver a analizar.
    const r2 = await svc.save(s4.id, 1, 2, { rle: encodeRle(lab) }, actor(medico));
    expect(r2.analisis).toBeNull();

    await svc.reset(s4.id, 1, 1, actor(medico));
    expect(await repos.files.read(`mascaras/${nv.id}/${s4.id}/toma1-r1.json.gz`)).toBeFalsy();
    const vuelta = (await repos.analyses.findByStudyId(s4.id)).puntual.tomas[0];
    expect(vuelta.metricas).toEqual(antes.puntual.tomas[0].metricas);
    expect(vuelta.calidadFotos.contornoPor).toBeNull();
    expect((await repos.maskCorrections.listByStudy(s4.id)).map((c) => c.replica)).toEqual([2]);
  });
});
