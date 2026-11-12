'use strict';

const { ROLES } = require('../models/roles');
const PatientView = require('../models/PatientView');
const Patient = require('../models/Patient');
const { EXCLUSION_CRITERIA, CONSENT_VERSION, CODIGO_REGEX, prefijoCentro } = require('../config/domain');
const { ConflictError, ForbiddenError, NotFoundError, ValidationError } = require('../utils/errors');
const { EVENTS } = require('../utils/eventBus');
const { normalize } = require('../utils/text');

/** Separa los datos personales (perfil de usuario) de los clínicos. */
function splitPersonal(data) {
  const personal = {};
  const clinical = {};
  for (const [k, v] of Object.entries(data)) {
    if (Patient.PERSONAL_FIELDS.includes(k)) personal[k] = v;
    else clinical[k] = v;
  }
  return { personal, clinical };
}

/** Casos de uso sobre pacientes: registro, ficha clínica, consentimiento y desenlace. */
class PatientService {
  constructor({ patients, users, studies, analyses, appointments, consents, userService, events }) {
    this.patients = patients;
    this.users = users;
    this.studies = studies;
    this.analyses = analyses;
    this.appointments = appointments;
    this.consents = consents;
    this.userService = userService;
    this.events = events;
  }

  /** Siguiente código anónimo para el centro: P.HC016, P.RF004, ... */
  async nextCodigo(centro) {
    const prefijo = prefijoCentro(centro);
    const codes = await this.patients.listCodigos();
    const max = codes
      .filter((c) => c.startsWith(`P.${prefijo}`) && /^\d+$/.test(c.slice(prefijo.length + 2)))
      .reduce((m, c) => Math.max(m, Number(c.slice(prefijo.length + 2))), 0);
    return `P.${prefijo}${String(max + 1).padStart(3, '0')}`;
  }

  async #view(patient) {
    if (!patient) return null;
    const user = patient.userId ? await this.users.findById(patient.userId) : null;
    return PatientView.from(patient, user);
  }

  async #views(patients) {
    const users = await this.users.findByIds(patients.map((p) => p.userId).filter(Boolean));
    const byId = new Map(users.map((u) => [u.id, u]));
    return patients.map((p) => PatientView.from(p, byId.get(p.userId)));
  }

  /**
   * Registra un paciente a partir de su correo (Gmail) y crea su cuenta con
   * contraseña temporal, que se muestra una única vez al médico.
   */
  async register(data, actor) {
    const excl = EXCLUSION_CRITERIA.filter((c) => data.exclusion?.[c.key]);
    if (excl.length) {
      throw new ValidationError(
        `El paciente cumple criterios de exclusión del protocolo: ${excl.map((c) => c.texto.toLowerCase()).join('; ')}.`,
        { exclusion: 'Cumple criterios de exclusión.' },
      );
    }
    if (!data.consentimientoFirmado) {
      throw new ValidationError('Se requiere el consentimiento informado firmado.', {
        consentimientoFirmado: 'Requerido para registrar al paciente.',
      });
    }
    const { personal, clinical } = splitPersonal(data);
    const codigo = clinical.codigo || (await this.nextCodigo(clinical.centro));
    if (!CODIGO_REGEX.test(codigo)) throw new ValidationError('Código inválido.', { codigo: 'Formato esperado: DEMO-002' });
    if (await this.patients.findByCodigo(codigo)) {
      throw new ConflictError(`Ya existe un paciente con el código ${codigo}.`);
    }
    if (clinical.dni && (await this.patients.findByDni(clinical.dni))) {
      throw new ConflictError('Ya existe un paciente con ese DNI.');
    }

    const { user, tempPassword } = await this.userService.createAccount({
      ...personal,
      role: ROLES.PACIENTE,
      institucion: clinical.centro,
    });

    const patient = await this.patients.create({ ...clinical, codigo, userId: user.id, medicoId: actor.id });
    await this.consents.create({
      patientId: patient.id,
      version: CONSENT_VERSION,
      fechaFirma: clinical.consentimientoFecha,
      registradoPor: actor.id,
      notas: 'Registrado en el alta del paciente.',
    });
    this.events.publish(EVENTS.PATIENT_CREATED, {
      actor,
      entity: 'paciente',
      entityId: patient.id,
      detail: `${patient.codigo} · cuenta de paciente creada`,
    });
    return { patient: PatientView.from(patient, user), user, tempPassword };
  }

  async update(id, data, actor) {
    const patient = await this.getForMedico(id, actor.id);
    const { personal, clinical } = splitPersonal(data);
    if (clinical.dni && clinical.dni !== patient.dni) {
      const other = await this.patients.findByDni(clinical.dni);
      if (other && other.id !== id) throw new ConflictError('Ya existe un paciente con ese DNI.');
    }
    // El código y el correo (identidad de acceso) no se editan desde la ficha.
    const { codigo: _c, consentimientoFirmado: _cf, consentimientoFecha: _cfe, ...changes } = clinical;
    const { email: _e, ...profile } = personal;
    await this.patients.update(id, changes);
    if (patient.userId && Object.keys(profile).length) await this.users.update(patient.userId, profile);
    this.events.publish(EVENTS.PATIENT_UPDATED, { actor, entity: 'paciente', entityId: id, detail: patient.codigo });
    return this.getForMedico(id, actor.id);
  }

  /** Paciente del médico (control de acceso a nivel de objeto), con datos personales. */
  async getForMedico(id, medicoId) {
    const patient = await this.patients.findById(id);
    if (!patient) throw new NotFoundError('El paciente no existe.');
    if (patient.medicoId !== medicoId) throw new ForbiddenError('Este paciente no está a tu cargo.');
    return this.#view(patient);
  }

  async getByUserId(userId) {
    const patient = await this.patients.findByUserId(userId);
    if (!patient) throw new NotFoundError('No encontramos tu ficha de paciente.');
    return this.#view(patient);
  }

  /**
   * Listado del médico con el último resultado y el próximo control de cada
   * paciente. Búsqueda por código o nombre y filtro por riesgo o grupo térmico.
   */
  async listForMedico(medicoId, { q, riesgo } = {}) {
    const [raw, studies, appts] = await Promise.all([
      this.patients.listByMedico(medicoId),
      this.studies.listByMedico(medicoId),
      this.appointments.listByMedico(medicoId),
    ]);
    const patients = await this.#views(raw);
    const analyses = await this.analyses.listByStudyIds(studies.map((s) => s.id));
    const analysisByStudy = new Map(analyses.map((a) => [a.studyId, a]));
    const needle = normalize(q);

    const rows = patients
      .filter((p) => !needle || normalize(`${p.codigo} ${p.nombre} ${p.apellido} ${p.email}`).includes(needle))
      .map((patient) => {
        const own = studies.filter((s) => s.patientId === patient.id); // ordenados desc.
        const lastWithResult = own.find((s) => analysisByStudy.has(s.id));
        return {
          patient,
          estudios: own.length,
          ultimoEstudio: own[0] || null,
          ultimoAnalisis: lastWithResult ? analysisByStudy.get(lastWithResult.id) : null,
          proximoControl: appts.find((a) => a.patientId === patient.id && a.estado === 'pendiente') || null,
        };
      });
    if (!riesgo) return rows;
    if (riesgo === 'sin_estudios') return rows.filter((r) => !r.ultimoAnalisis);
    if (riesgo === 'P' || riesgo === 'C') return rows.filter((r) => r.ultimoAnalisis?.grupo === riesgo);
    return rows.filter((r) => r.ultimoAnalisis?.categoria === riesgo);
  }

  /** Historia de estudios + serie temporal para el gráfico de evolución. */
  async history(patientId) {
    const studies = await this.studies.listByPatient(patientId);
    const analyses = await this.analyses.listByStudyIds(studies.map((s) => s.id));
    const byStudy = new Map(analyses.map((a) => [a.studyId, a]));
    const items = studies.map((study) => ({ study, analysis: byStudy.get(study.id) || null }));
    const serie = items
      .filter((i) => i.analysis)
      .slice()
      .reverse()
      .map((i) => ({
        fecha: i.study.fechaHora,
        toma: i.study.toma,
        probabilidad: i.analysis.probabilidad,
        deltaTMax: Math.abs(i.analysis.deltaTMax),
      }));
    return { items, serie };
  }

  /* ---------- Consentimiento informado ---------- */

  async listConsents(patientId) {
    return this.consents.listByPatient(patientId);
  }

  async registerConsent(patientId, { fechaFirma, notas }, actor) {
    const patient = await this.getForMedico(patientId, actor.id);
    const consent = await this.consents.create({
      patientId,
      version: CONSENT_VERSION,
      fechaFirma,
      registradoPor: actor.id,
      notas,
    });
    await this.patients.update(patientId, { consentimientoFirmado: true, consentimientoFecha: fechaFirma });
    this.events.publish(EVENTS.CONSENT_SIGNED, {
      actor,
      entity: 'paciente',
      entityId: patientId,
      detail: `${patient.codigo} · ${CONSENT_VERSION}`,
    });
    return consent;
  }

  async revokeConsent(patientId, { motivo }, actor) {
    const patient = await this.getForMedico(patientId, actor.id);
    const vigentes = (await this.consents.listByPatient(patientId)).filter((c) => c.vigente);
    const now = new Date().toISOString();
    for (const c of vigentes) await this.consents.update(c.id, { revocadoAt: now, motivoRevocacion: motivo });
    await this.patients.update(patientId, { consentimientoFirmado: false });
    this.events.publish(EVENTS.CONSENT_REVOKED, {
      actor,
      entity: 'paciente',
      entityId: patientId,
      detail: `${patient.codigo}: ${motivo}`,
    });
  }

  /* ---------- Desenlace del seguimiento ---------- */

  async recordOutcome(patientId, outcome, actor) {
    const patient = await this.getForMedico(patientId, actor.id);
    await this.patients.update(patientId, {
      generoLesion: outcome.generoLesion,
      lesionFecha: outcome.fecha,
      lesionPie: outcome.pie,
      lesionRoi: outcome.roi,
      lesionNotas: outcome.notas || null,
    });
    this.events.publish(EVENTS.OUTCOME_RECORDED, {
      actor,
      entity: 'paciente',
      entityId: patientId,
      detail: outcome.generoLesion
        ? `${patient.codigo}: generó lesión (pie ${outcome.pie}, ${outcome.roi})`
        : `${patient.codigo}: no generó lesión`,
    });
  }

  /**
   * Filas para la exportación CSV (anonimizada: sólo código, sin datos
   * personales). Una fila por estudio analizado.
   */
  async exportRows(medicoId) {
    const [patients, studies] = await Promise.all([
      this.patients.listByMedico(medicoId),
      this.studies.listByMedico(medicoId),
    ]);
    const analyses = await this.analyses.listByStudyIds(studies.map((s) => s.id));
    const byStudy = new Map(analyses.map((a) => [a.studyId, a]));
    const rows = [];
    for (const patient of patients) {
      const own = studies
        .filter((s) => s.patientId === patient.id && byStudy.has(s.id))
        .sort((a, b) => a.toma - b.toma || new Date(a.fechaHora) - new Date(b.fechaHora));
      if (!own.length) rows.push({ patient, study: null, analysis: null });
      for (const study of own) rows.push({ patient, study, analysis: byStudy.get(study.id) });
    }
    return rows;
  }

  async count() {
    return this.patients.count();
  }
}

module.exports = PatientService;
