'use strict';

const { ACQUISITION, DIAS_ENTRE_TOMAS } = require('../config/domain');

function numOr(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Entidad Estudio termográfico comparativo: compara la termografía basal
 * (toma 1) con la termografía de control (toma 2, ~30 días después) del mismo
 * paciente. Guarda las condiciones de adquisición de cada toma, las dos
 * imágenes, notas del médico y la visibilidad para el paciente.
 *
 * `fechaHora` es la fecha de la toma 2 (la visita actual); `fechaToma1` la
 * de la toma basal. Si la toma 1 se reutilizó de un estudio anterior,
 * `toma1OrigenStudyId` apunta a ese estudio.
 */
class Study {
  constructor(s) {
    this.id = s.id;
    this.patientId = s.patientId;
    this.medicoId = s.medicoId;
    this.fechaHora = s.fechaHora || new Date().toISOString();
    this.fechaToma1 = s.fechaToma1 || null;
    this.toma1OrigenStudyId = s.toma1OrigenStudyId || null;
    this.centro = s.centro || null;
    this.tempAmbiente = numOr(s.tempAmbiente, null);
    this.humedadRelativa = numOr(s.humedadRelativa, null);
    this.tempAmbienteToma1 = numOr(s.tempAmbienteToma1, null);
    this.humedadRelativaToma1 = numOr(s.humedadRelativaToma1, null);
    this.distanciaCm = numOr(s.distanciaCm, ACQUISITION.distanciaCm);
    this.emisividad = numOr(s.emisividad, ACQUISITION.emisividad);
    this.rangoMin = numOr(s.rangoMin, ACQUISITION.rango.min);
    this.rangoMax = numOr(s.rangoMax, ACQUISITION.rango.max);
    this.paleta = s.paleta || ACQUISITION.paletas[0];
    this.tiempoEstabilizacionMin = numOr(s.tiempoEstabilizacionMin, ACQUISITION.tiempoEstabilizacionMin);
    this.fondo = s.fondo || ACQUISITION.fondos[0];
    this.valida = s.valida !== false;
    this.motivoInvalidez = s.motivoInvalidez || null;
    this.checklist = Array.isArray(s.checklist) ? s.checklist : [];
    this.images = Array.isArray(s.images) ? s.images : [];
    this.estado = s.estado || 'borrador';
    this.notasMedico = s.notasMedico || '';
    this.publicado = Boolean(s.publicado);
    this.publicadoAt = s.publicadoAt || null;
    this.createdAt = s.createdAt || new Date().toISOString();
  }

  static inRange(v, { min, max }) {
    return v !== null && v >= min && v <= max;
  }

  get tempAmbienteOk() {
    return Study.inRange(this.tempAmbiente, ACQUISITION.tempAmbiente);
  }

  /** La humedad fue el factor ambiental más influyente en la Parte 1. */
  get humedadOk() {
    return Study.inRange(this.humedadRelativa, ACQUISITION.humedadRelativa);
  }

  get condicionesOk() {
    return this.tempAmbienteOk && this.humedadOk;
  }

  /** Condiciones de la toma 1 (sólo si se registraron). */
  get condicionesToma1Ok() {
    if (this.tempAmbienteToma1 === null && this.humedadRelativaToma1 === null) return null;
    return (
      Study.inRange(this.tempAmbienteToma1, ACQUISITION.tempAmbiente) &&
      Study.inRange(this.humedadRelativaToma1, ACQUISITION.humedadRelativa)
    );
  }

  /** Días transcurridos entre la toma 1 y la toma 2. */
  get diasEntreTomas() {
    if (!this.fechaToma1) return null;
    return Math.round((new Date(this.fechaHora) - new Date(this.fechaToma1)) / 86400000);
  }

  get intervaloOk() {
    const d = this.diasEntreTomas;
    return d !== null && d >= DIAS_ENTRE_TOMAS.min && d <= DIAS_ENTRE_TOMAS.max;
  }

  image(slot) {
    return this.images.find((i) => i.slot === slot) || null;
  }
}

module.exports = Study;
