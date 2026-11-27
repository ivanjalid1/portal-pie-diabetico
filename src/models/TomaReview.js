'use strict';

/**
 * Revisión manual de una TOMA de un estudio: qué foto (réplica) se usa en el
 * análisis, el estado (aprobada, rechazada o «Falta revisar»), un comentario,
 * quién la revisó y cuándo.
 *
 * `replicaElegida` null = se usa la réplica sugerida automáticamente por los
 * criterios de calidad (src/imaging/replicaChoice.js). Rechazar una toma es
 * sólo una marca: no la excluye del análisis.
 */
const ESTADOS = Object.freeze(['aprobado', 'rechazado', 'pendiente']);
const ETIQUETAS = Object.freeze({ aprobado: 'Aprobada', rechazado: 'Rechazada', pendiente: 'Falta revisar' });
const COMENTARIO_MAX = 1000;
const REPLICA_MAX = 20;

class TomaReview {
  constructor(r) {
    this.id = r.id;
    this.studyId = r.studyId;
    this.toma = Number(r.toma);
    const rep = r.replicaElegida === null || r.replicaElegida === undefined ? null : Number(r.replicaElegida);
    this.replicaElegida = Number.isInteger(rep) && rep >= 1 && rep <= REPLICA_MAX ? rep : null;
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

TomaReview.ESTADOS = ESTADOS;
TomaReview.ETIQUETAS = ETIQUETAS;
TomaReview.COMENTARIO_MAX = COMENTARIO_MAX;
TomaReview.REPLICA_MAX = REPLICA_MAX;

module.exports = TomaReview;
