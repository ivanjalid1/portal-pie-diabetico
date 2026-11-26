'use strict';

/**
 * Revisión manual de una foto (réplica de termograma de una toma) de un
 * estudio: aprobada, rechazada o pendiente («Falta revisar»), con un
 * comentario libre, quién la revisó y cuándo. Es sólo una etiqueta: no cambia
 * las temperaturas ni el análisis (una foto rechazada no se excluye).
 */
const ESTADOS = Object.freeze(['aprobado', 'rechazado', 'pendiente']);
const ETIQUETAS = Object.freeze({ aprobado: 'Aprobado', rechazado: 'Rechazado', pendiente: 'Falta revisar' });
const COMENTARIO_MAX = 1000;

class ImageReview {
  constructor(r) {
    this.id = r.id;
    this.studyId = r.studyId;
    this.toma = Number(r.toma);
    this.replica = Number(r.replica);
    this.estado = ESTADOS.includes(r.estado) ? r.estado : 'pendiente';
    this.comentario = r.comentario || '';
    this.revisadoPor = r.revisadoPor || null;
    this.revisadoAt = r.revisadoAt || null;
    this.createdAt = r.createdAt || new Date().toISOString();
    this.updatedAt = r.updatedAt || null;
  }

  get etiqueta() {
    return ETIQUETAS[this.estado];
  }
}

ImageReview.ESTADOS = ESTADOS;
ImageReview.ETIQUETAS = ETIQUETAS;
ImageReview.COMENTARIO_MAX = COMENTARIO_MAX;

module.exports = ImageReview;
