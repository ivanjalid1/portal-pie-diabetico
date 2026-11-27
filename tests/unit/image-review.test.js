'use strict';

const { buildContainer } = require('../../src/container');
const { buildConfig } = require('../../src/config');
const { EVENTS } = require('../../src/utils/eventBus');
const { ForbiddenError, NotFoundError } = require('../../src/utils/errors');
const { MemoryImageReviewRepository } = require('../../src/repositories/memory');
const { ImageReview } = require('../../src/models');
const { resumenTexto } = require('../../src/services/ImageReviewService');
const { imageReviewSchema } = require('../../src/validators/schemas');

function container() {
  const config = buildConfig({ NODE_ENV: 'test', DATA_DRIVER: 'memory' });
  return buildContainer({ config });
}

describe('MemoryImageReviewRepository', () => {
  const base = { studyId: 's1', toma: 1, replica: 1, estado: 'aprobado', comentario: '', revisadoPor: 'u1' };

  it('arranca vacío y guarda una revisión por foto', async () => {
    const repo = new MemoryImageReviewRepository();
    expect(await repo.listByStudy('s1')).toEqual([]);
    const r = await repo.upsert({ ...base, revisadoAt: '2026-11-01T10:00:00.000Z' });
    expect(r).toBeInstanceOf(ImageReview);
    expect(r.id).toBeTruthy();
    expect(r.estado).toBe('aprobado');
    expect(await repo.listByStudy('s1')).toHaveLength(1);
  });

  it('upsert actualiza la misma (estudio, toma, réplica) en lugar de duplicar', async () => {
    const repo = new MemoryImageReviewRepository();
    const a = await repo.upsert(base);
    const b = await repo.upsert({ ...base, estado: 'rechazado', comentario: 'Movida', revisadoPor: 'u2' });
    expect(b.id).toBe(a.id);
    const rows = await repo.listByStudy('s1');
    expect(rows).toHaveLength(1);
    expect(rows[0].estado).toBe('rechazado');
    expect(rows[0].comentario).toBe('Movida');
    expect(rows[0].revisadoPor).toBe('u2');
  });

  it('distingue toma, réplica y estudio', async () => {
    const repo = new MemoryImageReviewRepository();
    await repo.upsert(base);
    await repo.upsert({ ...base, replica: 2 });
    await repo.upsert({ ...base, toma: 2 });
    await repo.upsert({ ...base, studyId: 's2' });
    expect(await repo.listByStudy('s1')).toHaveLength(3);
    expect(await repo.listByStudy('s2')).toHaveLength(1);
  });

  it('no expone el estado interno por referencia', async () => {
    const repo = new MemoryImageReviewRepository();
    const r = await repo.upsert(base);
    r.estado = 'rechazado';
    expect((await repo.listByStudy('s1'))[0].estado).toBe('aprobado');
  });
});

describe('ImageReview (modelo)', () => {
  it('por defecto queda «pendiente» con su etiqueta', () => {
    const r = new ImageReview({ studyId: 's', toma: 1, replica: 1 });
    expect(r.estado).toBe('pendiente');
    expect(r.etiqueta).toBe('Falta revisar');
    expect(new ImageReview({ studyId: 's', toma: 1, replica: 1, estado: 'aprobado' }).etiqueta).toBe('Aprobado');
    expect(ImageReview.ESTADOS).toEqual(['aprobado', 'rechazado', 'pendiente']);
  });
});

describe('imageReviewSchema', () => {
  it('acepta los tres estados y recorta el comentario', () => {
    for (const estado of ['aprobado', 'rechazado', 'pendiente']) {
      expect(imageReviewSchema.safeParse({ estado }).success).toBe(true);
    }
    const r = imageReviewSchema.safeParse({ estado: 'rechazado', comentario: '  pie movido  ' });
    expect(r.data).toEqual({ estado: 'rechazado', comentario: 'pie movido' });
    expect(imageReviewSchema.parse({ estado: 'aprobado' }).comentario).toBe('');
  });

  it('rechaza estados desconocidos, vacíos y comentarios de más de 1000 caracteres', () => {
    expect(imageReviewSchema.safeParse({ estado: 'dudoso' }).success).toBe(false);
    expect(imageReviewSchema.safeParse({}).success).toBe(false);
    const largo = imageReviewSchema.safeParse({ estado: 'aprobado', comentario: 'x'.repeat(1001) });
    expect(largo.success).toBe(false);
    expect(largo.error.issues[0].path).toEqual(['comentario']);
    expect(imageReviewSchema.safeParse({ estado: 'aprobado', comentario: 'x'.repeat(1000) }).success).toBe(true);
  });
});

describe('resumenTexto', () => {
  it('pluraliza y omite los estados en cero', () => {
    expect(resumenTexto({ total: 6, aprobado: 4, rechazado: 1, pendiente: 1 })).toBe(
      '4 aprobadas · 1 rechazada · 1 por revisar',
    );
    expect(resumenTexto({ total: 2, aprobado: 1, rechazado: 0, pendiente: 1 })).toBe('1 aprobada · 1 por revisar');
    expect(resumenTexto({ total: 3, aprobado: 0, rechazado: 3, pendiente: 0 })).toBe('3 rechazadas');
    expect(resumenTexto({ total: 0, aprobado: 0, rechazado: 0, pendiente: 0 })).toBe('');
  });
});

describe('ImageReviewService', () => {
  let c;
  let svc;
  let medico;
  let otro;
  let study;
  const actor = (u) => ({ id: u.id, email: u.email, ip: '127.0.0.1', role: u.role });

  beforeEach(async () => {
    c = container();
    await c.ready;
    svc = c.services.imageReviewService;
    medico = await c.repos.users.findByEmail('medico@demo.com');
    otro = await c.repos.users.findByEmail('medico2@demo.com');
    [study] = await c.repos.studies.listByMedico(medico.id);
  });

  it('sin revisiones, todas las fotos del visor quedan «Falta revisar»', async () => {
    const visor = await c.services.viewerService.sources(study, null);
    const { fotos, resumen } = await svc.forStudy(study, visor);
    const total = visor.reduce((n, v) => n + v.reps.length, 0);
    expect(total).toBeGreaterThan(0);
    expect(fotos).toHaveLength(total);
    expect(fotos.every((f) => f.estado === 'pendiente' && f.revisor === null)).toBe(true);
    expect(resumen).toEqual({ total, aprobado: 0, rechazado: 0, pendiente: total });
  });

  it('guarda el estado, el comentario, quién y cuándo, y emite el evento de auditoría', async () => {
    const seen = [];
    c.events.on(EVENTS.IMAGE_REVIEWED, (p) => seen.push(p));
    const r = await svc.save(
      study.id,
      { toma: '1', replica: '1', estado: 'rechazado', comentario: 'Pie movido' },
      actor(medico),
    );
    expect(r.estado).toBe('rechazado');
    expect(r.comentario).toBe('Pie movido');
    expect(r.revisadoPor).toBe(medico.id);
    expect(Date.parse(r.revisadoAt)).not.toBeNaN();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ entity: 'estudio', entityId: study.id });
    expect(seen[0].detail).toMatch(/Toma 1 · réplica 1: rechazado/);

    const visor = await c.services.viewerService.sources(study, null);
    const { fotos, resumen } = await svc.forStudy(study, visor);
    const f = fotos.find((x) => x.toma === 1 && x.replica === 1);
    expect(f.estado).toBe('rechazado');
    expect(f.revisor).toBe(medico.nombreCompleto);
    expect(resumen.rechazado).toBe(1);
    expect(resumen.pendiente).toBe(resumen.total - 1);
  });

  it('volver a guardar reemplaza la revisión anterior', async () => {
    await svc.save(study.id, { toma: 2, replica: 1, estado: 'rechazado', comentario: 'x' }, actor(medico));
    await svc.save(study.id, { toma: 2, replica: 1, estado: 'aprobado', comentario: '' }, actor(medico));
    const rows = await c.repos.imageReviews.listByStudy(study.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].estado).toBe('aprobado');
  });

  it('no cambia los datos del análisis (las rechazadas sólo se etiquetan)', async () => {
    const antes = JSON.stringify(await c.repos.analyses.findByStudyId(study.id));
    await svc.save(study.id, { toma: 1, replica: 1, estado: 'rechazado', comentario: '' }, actor(medico));
    expect(JSON.stringify(await c.repos.analyses.findByStudyId(study.id))).toBe(antes);
  });

  it('otro médico no puede revisar fotos de un estudio ajeno', async () => {
    await expect(
      svc.save(study.id, { toma: 1, replica: 1, estado: 'aprobado', comentario: '' }, actor(otro)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await c.repos.imageReviews.listByStudy(study.id)).toEqual([]);
  });

  it('fotos inexistentes (toma o réplica fuera del visor) dan 404', async () => {
    for (const [toma, replica] of [
      [3, 1],
      [1, 2],
      [1, 0],
      ['a', 1],
      [1, 1.5],
    ]) {
      await expect(
        svc.save(study.id, { toma, replica, estado: 'aprobado', comentario: '' }, actor(medico)),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
    await expect(
      svc.save('no-existe', { toma: 1, replica: 1, estado: 'aprobado', comentario: '' }, actor(medico)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('MemoryImageReviewRepository#listByStudyIds', () => {
  it('devuelve las revisiones de varios estudios a la vez', async () => {
    const repo = new MemoryImageReviewRepository();
    const base = { toma: 1, replica: 1, estado: 'aprobado', comentario: '', revisadoPor: 'u1' };
    await repo.upsert({ ...base, studyId: 's1' });
    await repo.upsert({ ...base, studyId: 's2', replica: 2 });
    await repo.upsert({ ...base, studyId: 's3' });
    const rows = await repo.listByStudyIds(['s1', 's2']);
    expect(rows.map((r) => r.studyId).sort()).toEqual(['s1', 's2']);
    expect(await repo.listByStudyIds([])).toEqual([]);
  });
});

describe('ImageReviewService: página «Revisión de fotos»', () => {
  let c;
  let svc;
  let medico;
  let otro;
  let admin;
  let paciente;
  const actor = (u) => ({ id: u.id, email: u.email, ip: '127.0.0.1', role: u.role });

  beforeEach(async () => {
    c = container();
    await c.ready;
    svc = c.services.imageReviewService;
    medico = await c.repos.users.findByEmail('medico@demo.com');
    otro = await c.repos.users.findByEmail('medico2@demo.com');
    admin = await c.repos.users.findByEmail('admin@demo.com');
    paciente = await c.repos.users.findByEmail('paciente@demo.com');
  });

  it('el médico ve todas las fotos de sus estudios con el progreso', async () => {
    const studies = await c.repos.studies.listByMedico(medico.id);
    const ov = await svc.overview(actor(medico), { estado: 'todas' });
    expect(ov.resumen.total).toBe(studies.length * 2);
    expect(ov.resumen).toMatchObject({ revisadas: 0, aprobado: 0, rechazado: 0, pendiente: ov.resumen.total });
    expect(new Set(ov.fotos.map((f) => f.studyId))).toEqual(new Set(studies.map((s) => s.id)));
    const f = ov.fotos[0];
    expect(f).toMatchObject({ estado: 'pendiente', etiqueta: 'Falta revisar', revisor: null });
    expect(typeof f.codigo).toBe('string');
    expect(f).not.toHaveProperty('nombre');
  });

  it('el administrador ve las fotos de todos los médicos', async () => {
    const all = await c.repos.studies.listAll();
    const mine = await c.repos.studies.listByMedico(medico.id);
    const ov = await svc.overview(actor(admin), { estado: 'todas' });
    expect(all.length).toBeGreaterThan(mine.length);
    expect(ov.resumen.total).toBe(all.length * 2);
  });

  it('el paciente no tiene acceso', async () => {
    await expect(svc.overview(actor(paciente))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('filtra por estado y cuenta las revisadas', async () => {
    const [s1, s2] = await c.repos.studies.listByMedico(medico.id);
    await svc.save(s1.id, { toma: 1, replica: 1, estado: 'aprobado', comentario: '' }, actor(medico));
    await svc.save(s2.id, { toma: 2, replica: 1, estado: 'rechazado', comentario: 'Movida' }, actor(medico));
    const todas = await svc.overview(actor(medico), { estado: 'todas' });
    expect(todas.resumen).toMatchObject({ revisadas: 2, aprobado: 1, rechazado: 1 });
    expect(todas.resumen.pendiente).toBe(todas.resumen.total - 2);
    const apr = await svc.overview(actor(medico), { estado: 'aprobado' });
    expect(apr.fotos).toHaveLength(1);
    expect(apr.fotos[0]).toMatchObject({ studyId: s1.id, toma: 1, replica: 1, revisor: medico.nombreCompleto });
    const rec = await svc.overview(actor(medico), { estado: 'rechazado' });
    expect(rec.fotos.map((f) => f.comentario)).toEqual(['Movida']);
    const pend = await svc.overview(actor(medico));
    expect(pend.filtro).toBe('pendiente');
    expect(pend.fotos).toHaveLength(todas.resumen.total - 2);
    // El progreso es siempre del total, aunque se filtre.
    expect(pend.resumen.revisadas).toBe(2);
  });

  it('busca por código de paciente', async () => {
    const [s1] = await c.repos.studies.listByMedico(medico.id);
    const p = await c.repos.patients.findById(s1.patientId);
    const ov = await svc.overview(actor(medico), { estado: 'todas', q: p.codigo.toLowerCase() });
    expect(ov.fotos.length).toBeGreaterThan(0);
    expect(ov.fotos.every((f) => f.codigo === p.codigo)).toBe(true);
  });

  it('agrupa por estudio y toma y pagina sin cortar un grupo', async () => {
    const ov = await svc.overview(actor(admin), { estado: 'todas', size: 3 });
    expect(ov.pages).toBeGreaterThan(1);
    expect(ov.grupos.length).toBeGreaterThan(0);
    for (const g of ov.grupos) {
      expect(g.fotos.every((f) => f.studyId === g.studyId && f.toma === g.toma)).toBe(true);
    }
    const p2 = await svc.overview(actor(admin), { estado: 'todas', size: 3, page: 2 });
    expect(p2.page).toBe(2);
    expect(p2.grupos[0].key).not.toBe(ov.grupos[0].key);
  });

  it('el administrador puede revisar cualquier foto y queda su nombre', async () => {
    const [s] = await c.repos.studies.listByMedico(otro.id);
    const r = await svc.save(s.id, { toma: 1, replica: 1, estado: 'aprobado', comentario: 'ok' }, actor(admin));
    expect(r.revisadoPor).toBe(admin.id);
    const ov = await svc.overview(actor(admin), { estado: 'aprobado' });
    expect(ov.fotos[0].revisor).toBe(admin.nombreCompleto);
  });

  it('el paciente no puede guardar revisiones', async () => {
    const [s] = await c.repos.studies.listByMedico(medico.id);
    await expect(
      svc.save(s.id, { toma: 1, replica: 1, estado: 'aprobado', comentario: '' }, actor(paciente)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
