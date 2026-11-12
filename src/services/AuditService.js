'use strict';

const { EVENTS } = require('../utils/eventBus');

const ACTION_LABELS = Object.freeze({
  [EVENTS.USER_LOGIN]: 'Inicio de sesión',
  [EVENTS.USER_LOGIN_FAILED]: 'Intento de inicio de sesión fallido',
  [EVENTS.USER_LOGOUT]: 'Cierre de sesión',
  [EVENTS.USER_CREATED]: 'Alta de usuario',
  [EVENTS.USER_UPDATED]: 'Modificación de usuario',
  [EVENTS.USER_PASSWORD_CHANGED]: 'Cambio de contraseña',
  [EVENTS.USER_PASSWORD_RESET]: 'Restablecimiento de contraseña',
  [EVENTS.PATIENT_CREATED]: 'Alta de paciente',
  [EVENTS.PATIENT_UPDATED]: 'Edición de datos clínicos',
  [EVENTS.STUDY_CREATED]: 'Nuevo estudio termográfico',
  [EVENTS.ANALYSIS_COMPLETED]: 'Análisis completado',
  [EVENTS.STUDY_NOTES_UPDATED]: 'Notas del médico',
  [EVENTS.RESULT_PUBLISHED]: 'Resultado visible al paciente',
  [EVENTS.RESULT_UNPUBLISHED]: 'Resultado ocultado al paciente',
  [EVENTS.OUTCOME_RECORDED]: 'Registro de desenlace (¿generó lesión?)',
  [EVENTS.APPOINTMENT_SCHEDULED]: 'Control programado',
  [EVENTS.APPOINTMENT_UPDATED]: 'Control actualizado',
  [EVENTS.REPORT_EXPORTED]: 'Informe exportado',
  [EVENTS.DATA_EXPORTED]: 'Exportación CSV anonimizada',
  [EVENTS.CONSENT_SIGNED]: 'Consentimiento informado registrado',
  [EVENTS.CONSENT_REVOKED]: 'Consentimiento informado revocado',
});

/**
 * Servicio de auditoría: observador de todos los eventos de dominio.
 * Desacopla la trazabilidad de los casos de uso (patrón Observer).
 */
class AuditService {
  constructor({ audit, events }) {
    this.audit = audit;
    this.events = events;
  }

  /** Suscribe el servicio a todos los eventos conocidos. */
  subscribe() {
    for (const event of Object.values(EVENTS)) {
      this.events.on(event, (payload) => this.record(event, payload));
    }
    return this;
  }

  async record(action, payload = {}) {
    const actor = payload.actor || {};
    return this.audit.create({
      actorId: actor.id || null,
      actorEmail: actor.email || payload.email || 'sistema',
      action,
      entity: payload.entity || null,
      entityId: payload.entityId || null,
      detail: payload.detail || null,
      ip: actor.ip || null,
    });
  }

  async list(filter = {}) {
    return this.audit.list(filter);
  }

  static label(action) {
    return ACTION_LABELS[action] || action;
  }

  static get actions() {
    return ACTION_LABELS;
  }
}

module.exports = AuditService;
