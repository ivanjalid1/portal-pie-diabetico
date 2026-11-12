'use strict';

const { EventEmitter } = require('node:events');

/**
 * Bus de eventos de dominio (patrón Observer).
 *
 * Los servicios publican hechos (`patient.created`, `analysis.completed`, ...)
 * sin conocer a sus suscriptores. El `AuditService` se suscribe para registrar
 * la trazabilidad; en el futuro podrían agregarse notificaciones por correo
 * sin modificar los servicios emisores (principio Abierto/Cerrado).
 */
const EVENTS = Object.freeze({
  USER_LOGIN: 'user.login',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_LOGOUT: 'user.logout',
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_PASSWORD_CHANGED: 'user.password_changed',
  USER_PASSWORD_RESET: 'user.password_reset',
  PATIENT_CREATED: 'patient.created',
  PATIENT_UPDATED: 'patient.updated',
  STUDY_CREATED: 'study.created',
  ANALYSIS_COMPLETED: 'analysis.completed',
  STUDY_NOTES_UPDATED: 'study.notes_updated',
  RESULT_PUBLISHED: 'result.published',
  RESULT_UNPUBLISHED: 'result.unpublished',
  OUTCOME_RECORDED: 'outcome.recorded',
  APPOINTMENT_SCHEDULED: 'appointment.scheduled',
  APPOINTMENT_UPDATED: 'appointment.updated',
  REPORT_EXPORTED: 'report.exported',
  DATA_EXPORTED: 'data.exported',
  CONSENT_SIGNED: 'consent.signed',
  CONSENT_REVOKED: 'consent.revoked',
});

class DomainEventBus extends EventEmitter {
  /**
   * Publica un evento. Los errores de los suscriptores no deben interrumpir
   * el caso de uso que lo originó, por eso se capturan aquí.
   */
  publish(event, payload) {
    for (const listener of this.listeners(event)) {
      try {
        const r = listener(payload);
        if (r && typeof r.catch === 'function') {
          r.catch((err) => console.error(`[events] ${event}:`, err.message));
        }
      } catch (err) {
        console.error(`[events] ${event}:`, err.message);
      }
    }
  }
}

module.exports = { DomainEventBus, EVENTS };
