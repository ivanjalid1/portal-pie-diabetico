'use strict';

const { HORIZONTE_SEMANAS } = require('../config/domain');
const { ForbiddenError, NotFoundError } = require('../utils/errors');
const { EVENTS } = require('../utils/eventBus');

/** Programación de controles de seguimiento. */
class AppointmentService {
  constructor({ appointments, events }) {
    this.appointments = appointments;
    this.events = events;
  }

  /** Fecha por defecto: 6 semanas después de la fecha de referencia. */
  static defaultDate(from = new Date()) {
    const d = new Date(from);
    d.setDate(d.getDate() + HORIZONTE_SEMANAS * 7);
    return d.toISOString().slice(0, 10);
  }

  async schedule({ patient, studyId, fecha, motivo }, actor) {
    if (patient.medicoId !== actor.id) throw new ForbiddenError('Este paciente no está a tu cargo.');
    // Un nuevo control reemplaza al pendiente anterior del mismo paciente.
    const pending = (await this.appointments.listByPatient(patient.id)).filter((a) => a.estado === 'pendiente');
    for (const p of pending) await this.appointments.update(p.id, { estado: 'reprogramado' });

    const appt = await this.appointments.create({
      patientId: patient.id,
      medicoId: actor.id,
      studyId: studyId || null,
      fecha: fecha || AppointmentService.defaultDate(),
      motivo,
      estado: 'pendiente',
    });
    this.events.publish(EVENTS.APPOINTMENT_SCHEDULED, {
      actor,
      entity: 'control',
      entityId: appt.id,
      detail: `${patient.codigo} · ${appt.fecha}`,
    });
    return appt;
  }

  async setEstado(id, estado, actor) {
    const appt = await this.appointments.findById(id);
    if (!appt) throw new NotFoundError('El control no existe.');
    if (appt.medicoId !== actor.id) throw new ForbiddenError();
    const updated = await this.appointments.update(id, { estado });
    this.events.publish(EVENTS.APPOINTMENT_UPDATED, {
      actor,
      entity: 'control',
      entityId: id,
      detail: estado,
    });
    return updated;
  }

  async listForPatient(patientId) {
    return this.appointments.listByPatient(patientId);
  }

  async nextForPatient(patientId) {
    const list = await this.appointments.listByPatient(patientId);
    return list.find((a) => a.estado === 'pendiente') || null;
  }

  async pendingForMedico(medicoId) {
    return (await this.appointments.listByMedico(medicoId)).filter((a) => a.estado === 'pendiente');
  }
}

module.exports = AppointmentService;
