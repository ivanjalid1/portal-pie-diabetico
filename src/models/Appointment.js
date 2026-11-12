'use strict';

/** Control de seguimiento programado (por defecto, a 6 semanas del estudio). */
class Appointment {
  constructor(a) {
    this.id = a.id;
    this.patientId = a.patientId;
    this.medicoId = a.medicoId;
    this.studyId = a.studyId || null;
    this.fecha = a.fecha;
    this.motivo = a.motivo || 'Control termográfico de seguimiento';
    this.estado = a.estado || 'pendiente';
    this.createdAt = a.createdAt || new Date().toISOString();
  }

  vencido(ref = new Date()) {
    return this.estado === 'pendiente' && new Date(this.fecha) < ref;
  }
}

module.exports = Appointment;
