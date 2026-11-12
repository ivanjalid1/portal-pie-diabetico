'use strict';

const { HORIZONTE_SEMANAS } = require('../config/domain');
const { ForbiddenError, NotFoundError, ValidationError } = require('../utils/errors');
const { EVENTS } = require('../utils/eventBus');

const DAY = 86400000;

/** Controles de seguimiento: programación, cumplimiento, ausencias e historial. */
class AppointmentService {
  constructor({ appointments, studies, analyses, patientService, events }) {
    this.appointments = appointments;
    this.studies = studies;
    this.analyses = analyses;
    this.patientService = patientService;
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
      origenStudyId: studyId || null,
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

  /** Cambia el estado de un control: realizado, ausente (con motivo) o cancelado. */
  async setEstado(id, { estado, motivo, realizadoEn }, actor) {
    const appt = await this.appointments.findById(id);
    if (!appt) throw new NotFoundError('El control no existe.');
    if (appt.medicoId !== actor.id) throw new ForbiddenError();
    if (estado === 'ausente' && !motivo) {
      throw new ValidationError('Indicá el motivo de la ausencia.', { motivo: 'Requerido.' });
    }
    const patch = { estado };
    if (estado === 'realizado') patch.realizadoEn = realizadoEn || new Date().toISOString();
    if (estado === 'ausente') patch.motivoAusencia = motivo;
    const updated = await this.appointments.update(id, patch);
    this.events.publish(EVENTS.APPOINTMENT_UPDATED, {
      actor,
      entity: 'control',
      entityId: id,
      detail: estado === 'ausente' ? `ausente: ${motivo}` : estado,
    });
    return updated;
  }

  /**
   * Al guardar una toma 2, el control pendiente del paciente (el más próximo)
   * pasa a «realizado» y queda vinculado al estudio.
   */
  async completeWithStudy(study, actor) {
    const pending = (await this.appointments.listByPatient(study.patientId)).filter((a) => a.estado === 'pendiente');
    if (!pending.length) return null;
    const appt = pending[0];
    const updated = await this.appointments.update(appt.id, {
      estado: 'realizado',
      realizadoEn: study.fechaHora,
      studyId: study.id,
    });
    this.events.publish(EVENTS.APPOINTMENT_UPDATED, {
      actor,
      entity: 'control',
      entityId: appt.id,
      detail: 'realizado (vinculado al estudio)',
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

  /**
   * Controles del médico con paciente, estudio asociado y resultado, para la
   * vista «Controles» (próximos, vencidos, realizados) y su exportación.
   */
  async listDetailed(medicoId, { vista = 'proximos', desde, hasta, riesgo } = {}, now = new Date()) {
    const [all, rows] = await Promise.all([
      this.appointments.listByMedico(medicoId),
      this.patientService.listForMedico(medicoId),
    ]);
    const byPatient = new Map(rows.map((r) => [r.patient.id, r]));
    const studyIds = all.map((a) => a.studyId).filter(Boolean);
    const analyses = await this.analyses.listByStudyIds(studyIds);
    const aByStudy = new Map(analyses.map((a) => [a.studyId, a]));

    const counts = { proximos: 0, vencidos: 0, realizados: 0 };
    const items = [];
    for (const appt of all) {
      const row = byPatient.get(appt.patientId);
      if (!row) continue;
      let grupo = null;
      if (appt.estado === 'pendiente') grupo = appt.vencido(now) ? 'vencidos' : 'proximos';
      else if (appt.estado === 'realizado' || appt.estado === 'ausente') grupo = 'realizados';
      if (!grupo) continue;
      counts[grupo] += 1;
      if (grupo !== vista) continue;
      const analysis = appt.studyId ? aByStudy.get(appt.studyId) || null : null;
      const ref = new Date(appt.realizadoEn || `${String(appt.fecha).slice(0, 10)}T12:00:00`);
      if (desde && ref < new Date(`${desde}T00:00:00`)) continue;
      if (hasta && ref > new Date(`${hasta}T23:59:59`)) continue;
      const cat = analysis?.categoria || row.ultimoAnalisis?.categoria || null;
      if (riesgo && cat !== riesgo) continue;
      items.push({ appt, patient: row.patient, row, analysis });
    }
    const sortKey = (i) => new Date(i.appt.realizadoEn || i.appt.fecha).getTime();
    items.sort((a, b) => (vista === 'realizados' ? sortKey(b) - sortKey(a) : sortKey(a) - sortKey(b)));
    return { items, counts };
  }

  static daysUntil(fecha, now = new Date()) {
    return Math.round((new Date(`${String(fecha).slice(0, 10)}T12:00:00`) - now) / DAY);
  }
}

module.exports = AppointmentService;
