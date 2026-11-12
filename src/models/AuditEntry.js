'use strict';

/** Registro de auditoría (trazabilidad de accesos y acciones sobre datos clínicos). */
class AuditEntry {
  constructor(e) {
    this.id = e.id;
    this.actorId = e.actorId || null;
    this.actorEmail = e.actorEmail || 'sistema';
    this.action = e.action;
    this.entity = e.entity || null;
    this.entityId = e.entityId || null;
    this.detail = e.detail || null;
    this.ip = e.ip || null;
    this.createdAt = e.createdAt || new Date().toISOString();
  }
}

module.exports = AuditEntry;
