'use strict';

const { ACQUISITION } = require('../config/domain');

function numOr(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Entidad Estudio termográfico (una «toma» del protocolo): metadatos de
 * adquisición, las dos imágenes, notas del médico y visibilidad para el paciente.
 */
class Study {
  constructor(s) {
    this.id = s.id;
    this.patientId = s.patientId;
    this.medicoId = s.medicoId;
    this.toma = numOr(s.toma, 1);
    this.fechaHora = s.fechaHora || new Date().toISOString();
    this.centro = s.centro || null;
    this.tempAmbiente = numOr(s.tempAmbiente, null);
    this.humedadRelativa = numOr(s.humedadRelativa, null);
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

  get tempAmbienteOk() {
    const { min, max } = ACQUISITION.tempAmbiente;
    return this.tempAmbiente !== null && this.tempAmbiente >= min && this.tempAmbiente <= max;
  }

  /** La humedad fue el factor ambiental más influyente en la Parte 1. */
  get humedadOk() {
    const { min, max } = ACQUISITION.humedadRelativa;
    return this.humedadRelativa !== null && this.humedadRelativa >= min && this.humedadRelativa <= max;
  }

  get condicionesOk() {
    return this.tempAmbienteOk && this.humedadOk;
  }

  image(slot) {
    return this.images.find((i) => i.slot === slot) || null;
  }
}

module.exports = Study;
