'use strict';

/**
 * Consentimiento informado (Ley 26.529, art. 5 y 6; Ley 25.326, art. 5).
 * Se conserva el historial: cada firma o revocación es un registro.
 */
class Consent {
  constructor(c) {
    this.id = c.id;
    this.patientId = c.patientId;
    this.version = c.version;
    this.fechaFirma = c.fechaFirma;
    this.registradoPor = c.registradoPor || null;
    this.revocadoAt = c.revocadoAt || null;
    this.motivoRevocacion = c.motivoRevocacion || null;
    this.notas = c.notas || null;
    this.createdAt = c.createdAt || new Date().toISOString();
  }

  get vigente() {
    return !this.revocadoAt;
  }
}

module.exports = Consent;
