'use strict';

const ImageReview = require('../models/ImageReview');
const { EVENTS } = require('../utils/eventBus');
const { NotFoundError } = require('../utils/errors');

const key = (toma, replica) => `${toma}-${replica}`;

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

  /** Guarda (crea o reemplaza) la revisión de una foto del estudio del médico. */
  async save(studyId, { toma, replica, estado, comentario = '' }, actor) {
    const data = await this.studyService.getForMedico(studyId, actor.id);
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

module.exports = { ImageReviewService, resumenTexto, guardadoTexto };
