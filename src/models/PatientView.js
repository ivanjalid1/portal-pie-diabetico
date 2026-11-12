'use strict';

const Patient = require('./Patient');

/**
 * DTO de presentación (patrón DTO/Mapper): combina la entidad clínica
 * `Patient` con los datos personales del perfil de usuario. Sólo se construye
 * para quien tiene derecho a verlos (médico tratante o el propio paciente);
 * nunca se persiste ni se exporta (el CSV usa únicamente el código).
 */
class PatientView extends Patient {
  constructor(patient, user) {
    super(patient);
    this.nombre = user?.nombre || '';
    this.apellido = user?.apellido || '';
    this.email = user?.email || null;
    this.telefono = user?.telefono || null;
  }

  get nombreCompleto() {
    return `${this.nombre} ${this.apellido}`.trim() || this.codigo;
  }

  get iniciales() {
    return `${this.nombre[0] || ''}${this.apellido[0] || ''}`.toUpperCase() || 'P';
  }

  static from(patient, user) {
    return patient ? new PatientView(patient, user) : null;
  }
}

module.exports = PatientView;
