'use strict';

/**
 * Control de seguimiento.
 *
 * Estados: `pendiente` → `realizado` (con fecha real y estudio asociado),
 * `ausente` (con motivo), `cancelado` o `reprogramado` (reemplazado por otro).
 * `origenStudyId` es el estudio desde el que se programó; `studyId` el estudio
 * realizado en ese control (se vincula automáticamente al cargar la toma 2).
 */
class Appointment {
  constructor(a) {
    this.id = a.id;
    this.patientId = a.patientId;
    this.medicoId = a.medicoId;
    this.studyId = a.studyId || null;
    this.origenStudyId = a.origenStudyId || null;
    this.fecha = a.fecha;
    this.motivo = a.motivo || 'Control termográfico de seguimiento';
    this.estado = a.estado || 'pendiente';
    this.realizadoEn = a.realizadoEn || null;
    this.motivoAusencia = a.motivoAusencia || null;
    this.createdAt = a.createdAt || new Date().toISOString();
  }

  vencido(ref = new Date()) {
    if (this.estado !== 'pendiente') return false;
    const d = new Date(`${String(this.fecha).slice(0, 10)}T23:59:59`);
    return d < ref;
  }

  /** Días de diferencia entre lo programado y lo realizado (positivo = tarde). */
  get desvioDias() {
    if (!this.realizadoEn) return null;
    const prog = new Date(`${String(this.fecha).slice(0, 10)}T12:00:00`);
    const real = new Date(this.realizadoEn);
    return Math.round((real - prog) / 86400000);
  }
}

Appointment.ESTADOS = Object.freeze({
  pendiente: { nombre: 'Pendiente', tono: 'info' },
  realizado: { nombre: 'Realizado', tono: 'ok' },
  ausente: { nombre: 'Ausente', tono: 'warn' },
  cancelado: { nombre: 'Cancelado', tono: 'muted' },
  reprogramado: { nombre: 'Reprogramado', tono: 'muted' },
});

module.exports = Appointment;
