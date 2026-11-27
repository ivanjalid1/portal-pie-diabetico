'use strict';

const { buildContainer } = require('../../src/container');
const { buildConfig } = require('../../src/config');
const { EVENTS } = require('../../src/utils/eventBus');
const { ForbiddenError, NotFoundError } = require('../../src/utils/errors');
const { MemoryTomaReviewRepository } = require('../../src/repositories/memory');
const { TomaReview } = require('../../src/models');
const { tomaReviewSchema } = require('../../src/validators/schemas');
const {
  pasaCriterios,
  sugerirReplica,
  calidadConReplica,
  tomaConReplica,
  fotoUsada,
} = require('../../src/imaging/replicaChoice');

function container() {
  const config = buildConfig({ NODE_ENV: 'test', DATA_DRIVER: 'memory' });
  return buildContainer({ config });
}
const actor = (u) => ({ id: u.id, email: u.email, ip: '127.0.0.1', role: u.role });

describe('replicaChoice: una sola foto por toma', () => {
  it('pasaCriterios: sólo las banderas graves excluyen', () => {
    expect(pasaCriterios({ banderas: [] })).toBe(true);
    expect(pasaCriterios({ banderas: ['pies_girados', 'fondo_tibio', 'foto_borrosa'] })).toBe(true);
    expect(pasaCriterios({ banderas: ['talon_cortado'] })).toBe(false);
    expect(pasaCriterios({})).toBe(false);
  });

  it('sugiere la mejor sin banderas graves aunque otra tenga más puntaje', () => {
    const c = [
      { rep: 0, puntaje: 0.95, banderas: ['talon_cortado'] },
      { rep: 1, puntaje: 0.8, banderas: [] },
      { rep: 2, puntaje: 0.9, banderas: ['fondo_tibio'] },
    ];
    expect(sugerirReplica(c).rep).toBe(2);
  });

  it('si ninguna pasa, la menos afectada; empates: la primera captura', () => {
    const c = [
      { rep: 0, puntaje: 0.7, banderas: ['talon_cortado'] },
      { rep: 1, puntaje: 0.705, banderas: ['camara_lejos'] },
    ];
    expect(sugerirReplica(c).rep).toBe(0);
    expect(sugerirReplica(c, { empate: 0 }).rep).toBe(1);
  });

  it('calidadConReplica: banderas de la usada, sugerida y quién la eligió', () => {
    const base = { replicas: 3, limpias: 2, sugerida: 1, rep: 1, baja: false, banderas: [] };
    const q = calidadConReplica(base, { rep: 3, banderas: ['talon_cortado'] }, { revisor: 'Ana P' });
    expect(q).toEqual({
      replicas: 3,
      limpias: 2,
      sugerida: 1,
      rep: 3,
      baja: true,
      banderas: ['talon_cortado'],
      elegidaPor: 'Ana P',
      contornoPor: null,
    });
    expect(calidadConReplica(base, { rep: 1, banderas: [] }).elegidaPor).toBeNull();
  });

  it('tomaConReplica cambia grillas, TCI y calidad, y conserva fecha y ambiente', () => {
    const toma = { toma: 2, izq: 'a', der: 'b', tci: { valor: 1 }, fecha: 'f', ambiente: { tempC: 22 }, calidad: 0.9 };
    const r = tomaConReplica(toma, { rep: 2, izq: 'c', der: 'd', tci: { valor: 2 }, calidad: 0.8, banderas: [] });
    expect(r).toMatchObject({ toma: 2, izq: 'c', der: 'd', tci: { valor: 2 }, fecha: 'f', calidad: 0.8 });
    expect(r.ambiente).toEqual({ tempC: 22 });
    expect(r.calidadFotos.rep).toBe(2);
  });

  it('fotoUsada: «Foto 2 de 3 · elegida por X» o «sugerida automáticamente»', () => {
    expect(fotoUsada({ calidadFotos: { rep: 2, replicas: 3, elegidaPor: 'Ana P' } }).corto).toBe(
      'Foto 2 de 3 · elegida por Ana P',
    );
    expect(fotoUsada({ calidadFotos: { rep: 1, replicas: 3 } }).corto).toBe('Foto 1 de 3 · sugerida automáticamente');
    expect(fotoUsada({})).toBeNull();
  });
});

describe('MemoryTomaReviewRepository', () => {
  const base = { studyId: 's1', toma: 1, replicaElegida: null, estado: 'aprobado', comentario: '', revisadoPor: 'u1' };

  it('upsert: una fila por (estudio, toma)', async () => {
    const repo = new MemoryTomaReviewRepository();
    expect(await repo.listByStudy('s1')).toEqual([]);
    const a = await repo.upsert(base);
    expect(a).toBeInstanceOf(TomaReview);
    const b = await repo.upsert({ ...base, replicaElegida: 3, estado: 'rechazado', comentario: 'Movida' });
    expect(b.id).toBe(a.id);
    const rows = await repo.listByStudy('s1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ replicaElegida: 3, estado: 'rechazado', comentario: 'Movida' });
    await repo.upsert({ ...base, toma: 2 });
    await repo.upsert({ ...base, studyId: 's2' });
    expect(await repo.listByStudy('s1')).toHaveLength(2);
    expect((await repo.listByStudyIds(['s1', 's2'])).length).toBe(3);
    expect(await repo.listByStudyIds([])).toEqual([]);
  });

  it('modelo: «pendiente» por defecto y réplica fuera de rango = sugerida', () => {
    const r = new TomaReview({ studyId: 's', toma: 1 });
    expect(r).toMatchObject({ estado: 'pendiente', etiqueta: 'Falta revisar', replicaElegida: null });
    expect(new TomaReview({ studyId: 's', toma: 1, replicaElegida: 99 }).replicaElegida).toBeNull();
    expect(new TomaReview({ studyId: 's', toma: 1, estado: 'aprobado' }).etiqueta).toBe('Aprobada');
  });
});

describe('tomaReviewSchema', () => {
  it('acepta estados, réplica opcional y recorta el comentario', () => {
    expect(tomaReviewSchema.parse({ estado: 'aprobado' })).toEqual({ estado: 'aprobado', comentario: '' });
    expect(tomaReviewSchema.parse({ estado: 'pendiente', replica: '2', comentario: ' x ' })).toEqual({
      estado: 'pendiente',
      replica: 2,
      comentario: 'x',
    });
    expect(tomaReviewSchema.parse({ estado: 'aprobado', replica: '' }).replica).toBeUndefined();
  });
  it('rechaza estados, réplicas y comentarios inválidos', () => {
    expect(tomaReviewSchema.safeParse({ estado: 'quizas' }).success).toBe(false);
    expect(tomaReviewSchema.safeParse({}).success).toBe(false);
    for (const replica of ['0', '21', '1.5', 'x']) {
      expect(tomaReviewSchema.safeParse({ estado: 'aprobado', replica }).success).toBe(false);
    }
    expect(tomaReviewSchema.safeParse({ estado: 'aprobado', comentario: 'x'.repeat(1001) }).success).toBe(false);
  });
});

describe('TomaReviewService (demo: una foto por toma)', () => {
  let c;
  let svc;
  let medico;
  let otro;
  let admin;
  let paciente;
  let study;

  beforeEach(async () => {
    c = container();
    await c.ready;
    svc = c.services.tomaReviewService;
    medico = await c.repos.users.findByEmail('medico@demo.com');
    otro = await c.repos.users.findByEmail('medico2@demo.com');
    admin = await c.repos.users.findByEmail('admin@demo.com');
    paciente = await c.repos.users.findByEmail('paciente@demo.com');
    [study] = await c.repos.studies.listByMedico(medico.id);
  });

  it('una tarjeta por toma, todas «Falta revisar», con la foto sugerida en uso', async () => {
    const studies = await c.repos.studies.listByMedico(medico.id);
    const ov = await svc.overview(actor(medico), { estado: 'todas' });
    expect(ov.resumen.total).toBe(studies.length * 2);
    expect(ov.resumen).toMatchObject({ revisadas: 0, pendiente: ov.resumen.total });
    const t = ov.tomas[0];
    expect(t).toMatchObject({ estado: 'pendiente', etiqueta: 'Falta revisar', replicaElegida: null, usada: 1 });
    expect(t.usadaTexto).toBe('Foto 1 · sugerida automáticamente');
    expect(t.reps[0]).toMatchObject({ rep: 1, sugerida: true, usada: true });
    expect(t).not.toHaveProperty('nombre');
  });

  it('guarda estado y comentario con quién y cuándo, emite auditoría y no toca el análisis', async () => {
    const seen = [];
    c.events.on(EVENTS.TOMA_REVIEWED, (p) => seen.push(p));
    const antes = JSON.stringify(await c.repos.analyses.findByStudyId(study.id));
    const { review, analisis } = await svc.save(
      study.id,
      '1',
      { estado: 'rechazado', comentario: 'Pie movido' },
      actor(medico),
    );
    expect(review).toMatchObject({ toma: 1, estado: 'rechazado', comentario: 'Pie movido', revisadoPor: medico.id });
    expect(analisis).toBeNull();
    expect(JSON.stringify(await c.repos.analyses.findByStudyId(study.id))).toBe(antes);
    expect(seen[0].detail).toMatch(/toma 1: foto 1 \(sugerida\), rechazada/);
    const t = await svc.forToma(study, await c.repos.patients.findById(study.patientId), 1);
    expect(t).toMatchObject({ estado: 'rechazado', revisor: medico.nombreCompleto });
    // Volver a guardar reemplaza.
    await svc.save(study.id, 1, { estado: 'pendiente', comentario: '' }, actor(medico));
    const rows = await c.repos.tomaReviews.listByStudy(study.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].estado).toBe('pendiente');
  });

  it('filtros, búsqueda, paginación y progreso total', async () => {
    const [s1, s2] = await c.repos.studies.listByMedico(medico.id);
    await svc.save(s1.id, 1, { estado: 'aprobado' }, actor(medico));
    await svc.save(s2.id, 2, { estado: 'rechazado', comentario: 'Movida' }, actor(medico));
    const todas = await svc.overview(actor(medico), { estado: 'todas' });
    expect(todas.resumen).toMatchObject({ revisadas: 2, aprobado: 1, rechazado: 1 });
    const apr = await svc.overview(actor(medico), { estado: 'aprobado' });
    expect(apr.tomas.map((t) => [t.studyId, t.toma])).toEqual([[s1.id, 1]]);
    const rec = await svc.overview(actor(medico), { estado: 'rechazado' });
    expect(rec.tomas.map((t) => t.comentario)).toEqual(['Movida']);
    const pend = await svc.overview(actor(medico));
    expect(pend.filtro).toBe('pendiente');
    expect(pend.totalFiltrado).toBe(todas.resumen.total - 2);
    const p = await c.repos.patients.findById(s1.patientId);
    const q = await svc.overview(actor(medico), { estado: 'todas', q: p.codigo.toLowerCase() });
    expect(q.tomas.length).toBeGreaterThan(0);
    expect(q.tomas.every((t) => t.codigo === p.codigo)).toBe(true);
    const pg = await svc.overview(actor(medico), { estado: 'todas', size: 3, page: 2 });
    expect(pg.tomas).toHaveLength(3);
    expect(pg.page).toBe(2);
  });

  it('acceso: otro médico y el paciente no; el administrador sí (con su nombre)', async () => {
    await expect(svc.save(study.id, 1, { estado: 'aprobado' }, actor(otro))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(svc.save(study.id, 1, { estado: 'aprobado' }, actor(paciente))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(svc.overview(actor(paciente))).rejects.toBeInstanceOf(ForbiddenError);
    const { review } = await svc.save(study.id, 1, { estado: 'aprobado' }, actor(admin));
    expect(review.revisadoPor).toBe(admin.id);
    const all = await c.repos.studies.listAll();
    expect((await svc.overview(actor(admin), { estado: 'todas' })).resumen.total).toBe(all.length * 2);
  });

  it('toma o foto inexistente: 404', async () => {
    for (const [toma, replica] of [
      [3, undefined],
      ['a', undefined],
      [1, 2],
    ]) {
      await expect(svc.save(study.id, toma, { replica, estado: 'aprobado' }, actor(medico))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    }
    await expect(svc.save('no-existe', 1, { estado: 'aprobado' }, actor(medico))).rejects.toBeInstanceOf(NotFoundError);
  });
});
