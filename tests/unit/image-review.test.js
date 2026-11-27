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
