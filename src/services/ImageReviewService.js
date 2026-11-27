'use strict';

const ImageReview = require('../models/ImageReview');
const { EVENTS } = require('../utils/eventBus');
const { NotFoundError } = require('../utils/errors');

const key = (toma, replica) => `${toma}-${replica}`;

/** Filtros de la página «Revisión de fotos» (el primero es el predeterminado). */
const FILTROS = Object.freeze(['pendiente', 'aprobado', 'rechazado', 'calidad', 'avisos', 'todas']);
const FILTRO_OK = {
  pendiente: (f) => f.estado === 'pendiente',
  aprobado: (f) => f.estado === 'aprobado',
  rechazado: (f) => f.estado === 'rechazado',
  calidad: (f) => f.calidadBaja,
  avisos: (f) => f.avisos.length > 0,
  todas: () => true,
};

/** Promise.all con un máximo de `n` tareas a la vez (manifiestos remotos). */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** «4 aprobadas · 1 rechazada · 1 por revisar» (omite los estados en cero). */
function resumenTexto(resumen) {
  const parts = [];
  const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
  if (resumen.aprobado) parts.push(plural(resumen.aprobado, 'aprobada', 'aprobadas'));
  if (resumen.rechazado) parts.push(plural(resumen.rechazado, 'rechazada', 'rechazadas'));
  if (resumen.pendiente) parts.push(`${resumen.pendiente} por revisar`);
  return parts.join(' · ');
}

/** «Guardado por Nombre Apellido · 26/11/2026 10:30» (vacío si nunca se guardó). */
function guardadoTexto(foto, fmt) {
  if (!foto?.revisadoAt) return '';
  return `Guardado por ${foto.revisor || 'un usuario'} · ${fmt.dateTime(foto.revisadoAt)}`;
}

/**
 * Revisión manual de las fotos de un estudio (cada réplica de cada toma del
 * visor): aprobada, rechazada o «Falta revisar», con un comentario.
 *
 * Es sólo una etiqueta para el equipo: no modifica temperaturas ni análisis y
 * una foto rechazada sigue formando parte del análisis.
 */
class ImageReviewService {
  constructor({ reviews, users, studyService, viewerService = null, events }) {
    this.reviews = reviews;
    this.users = users;
    this.studyService = studyService;
    this.viewerService = viewerService;
    this.events = events;
  }

  /** Fotos del visor (ThermalViewerService#sources) como pares toma/réplica. */
  static photosOf(visor = []) {
    return visor.flatMap((v) => v.reps.map((r) => ({ toma: v.toma, replica: r.rep })));
  }

  /**
   * Estado de revisión de cada foto del visor de un estudio ya autorizado.
   * @returns {Promise<{fotos: Array, resumen: {total:number, aprobado:number, rechazado:number, pendiente:number}}>}
   */
  async forStudy(study, visor) {
    const photos = ImageReviewService.photosOf(visor);
    const rows = photos.length ? await this.reviews.listByStudy(study.id) : [];
    const byKey = new Map(rows.map((r) => [key(r.toma, r.replica), r]));
    const ids = [...new Set(rows.map((r) => r.revisadoPor).filter(Boolean))];
    const names = new Map((ids.length ? await this.users.findByIds(ids) : []).map((u) => [u.id, u.nombreCompleto]));
    const resumen = { total: photos.length, aprobado: 0, rechazado: 0, pendiente: 0 };
    const fotos = photos.map(({ toma, replica }) => {
      const r = byKey.get(key(toma, replica)) || new ImageReview({ studyId: study.id, toma, replica });
      resumen[r.estado] += 1;
      return {
        toma,
        replica,
        estado: r.estado,
        etiqueta: r.etiqueta,
        comentario: r.comentario,
        revisor: r.revisadoPor ? names.get(r.revisadoPor) || null : null,
        revisadoAt: r.revisadoAt,
      };
    });
    return { fotos, resumen };
  }

  /** Nombres de los revisores (id → nombre completo). */
  async reviewerNames(rows) {
    const ids = [...new Set(rows.map((r) => r.revisadoPor).filter(Boolean))];
    return new Map((ids.length ? await this.users.findByIds(ids) : []).map((u) => [u.id, u.nombreCompleto]));
  }

  /**
   * Todas las fotos que el usuario puede revisar (médico/a: sus estudios;
   * administrador/a: todos), con el progreso total, los conteos por filtro y
   * la página pedida agrupada por estudio y toma. Sólo expone el código del
   * paciente (nunca nombre ni DNI).
   * @param {{estado?:string, q?:string, page?:number, size?:number}} f
   */
  async overview(user, { estado = FILTROS[0], q = '', page = 1, size = 48 } = {}) {
    const filtro = FILTROS.includes(estado) ? estado : FILTROS[0];
    const items = await this.studyService.listForReviewer(user);
    const visores = await mapLimit(items, 8, ({ study, patient }) =>
      this.viewerService ? this.viewerService.sources(study, patient, { info: false }).catch(() => []) : [],
    );
    const rows = items.length ? await this.reviews.listByStudyIds(items.map((x) => x.study.id)) : [];
    const byKey = new Map(rows.map((r) => [`${r.studyId}:${key(r.toma, r.replica)}`, r]));
    const names = await this.reviewerNames(rows);

    const todas = [];
    items.forEach(({ study, patient }, i) => {
      for (const v of visores[i]) {
        for (const rep of v.reps) {
          const r =
            byKey.get(`${study.id}:${key(v.toma, rep.rep)}`) ||
            new ImageReview({ studyId: study.id, toma: v.toma, replica: rep.rep });
          todas.push({
            studyId: study.id,
            codigo: patient.codigo,
            fechaToma: v.toma === 1 ? study.fechaToma1 || study.fechaHora : study.fechaHora,
            toma: v.toma,
            replica: rep.rep,
            nReps: v.reps.length,
            estado: r.estado,
            etiqueta: r.etiqueta,
            comentario: r.comentario,
            revisor: r.revisadoPor ? names.get(r.revisadoPor) || null : null,
            revisadoAt: r.revisadoAt,
            avisos: rep.avisos || [],
            calidadBaja: Boolean(v.calidadBaja),
            mejor: Boolean(rep.mejor),
            enPromedio: Boolean(rep.enPromedio),
            foto: Boolean(rep.foto),
          });
        }
      }
    });
    todas.sort(
      (a, b) =>
        a.codigo.localeCompare(b.codigo, 'es', { numeric: true }) ||
        String(a.studyId).localeCompare(String(b.studyId)) ||
        a.toma - b.toma ||
        a.replica - b.replica,
    );

    const conteos = Object.fromEntries(FILTROS.map((k) => [k, todas.filter(FILTRO_OK[k]).length]));
    const resumen = {
      total: todas.length,
      revisadas: conteos.aprobado + conteos.rechazado,
      aprobado: conteos.aprobado,
      rechazado: conteos.rechazado,
      pendiente: conteos.pendiente,
    };

    const needle = String(q || '')
      .trim()
      .toLowerCase();
    const fotos = todas.filter((f) => FILTRO_OK[filtro](f) && (!needle || f.codigo.toLowerCase().includes(needle)));

    // Grupos por estudio y toma; cada página junta grupos enteros hasta `size` fotos.
    const grupos = [];
    for (const f of fotos) {
      const k = `${f.studyId}-${f.toma}`;
      const last = grupos.at(-1);
      if (last && last.key === k) last.fotos.push(f);
      else
        grupos.push({ key: k, studyId: f.studyId, codigo: f.codigo, toma: f.toma, fechaToma: f.fechaToma, fotos: [f] });
    }
    const paginas = [];
    for (const g of grupos) {
      const cur = paginas.at(-1);
      if (!cur || cur.n >= size) paginas.push({ n: g.fotos.length, grupos: [g] });
      else {
        cur.grupos.push(g);
        cur.n += g.fotos.length;
      }
    }
    const pages = Math.max(1, paginas.length);
    const pg = Math.min(Math.max(1, Number(page) || 1), pages);
    return {
      filtro,
      q: needle,
      resumen,
      conteos,
      fotos,
      totalFiltrado: fotos.length,
      grupos: paginas[pg - 1]?.grupos || [],
      page: pg,
      pages,
    };
  }

  /**
   * Guarda (crea o reemplaza) la revisión de una foto: el médico/a tratante o
   * el administrador/a (ver StudyService#getForReviewer).
   */
  async save(studyId, { toma, replica, estado, comentario = '' }, actor) {
    const data = await this.studyService.getForReviewer(studyId, actor);
    const t = Number(toma);
    const r = Number(replica);
    if (![1, 2].includes(t) || !Number.isInteger(r) || r < 1 || r > 20) throw new NotFoundError('La foto no existe.');
    if (this.viewerService) {
      const visor = await this.viewerService.sources(data.study, data.patient);
      const existe = ImageReviewService.photosOf(visor).some((p) => p.toma === t && p.replica === r);
      if (!existe) throw new NotFoundError('La foto no existe.');
    }
    const saved = await this.reviews.upsert({
      studyId,
      toma: t,
      replica: r,
      estado,
      comentario: String(comentario || '').slice(0, ImageReview.COMENTARIO_MAX),
      revisadoPor: actor.id,
      revisadoAt: new Date().toISOString(),
    });
    this.events.publish(EVENTS.IMAGE_REVIEWED, {
      actor,
      entity: 'estudio',
      entityId: studyId,
      detail: `Toma ${t} · réplica ${r}: ${estado}`,
    });
    return saved;
  }
}

module.exports = { ImageReviewService, resumenTexto, guardadoTexto, FILTROS };
