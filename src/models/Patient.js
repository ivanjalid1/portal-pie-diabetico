'use strict';

const {
  neuropathyGrade,
  VIBRATORIA_CORTE,
  HBA1C_MAX_MESES,
  EXCLUSION_CRITERIA,
} = require('../config/domain');

const EXCLUSION_KEYS = EXCLUSION_CRITERIA.map((c) => c.key);

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Booleano que admite «sin dato» (null), p. ej. tabaquismo «a consultar». */
function triState(v) {
  if (v === null || v === undefined || v === '') return null;
  return Boolean(v);
}

/**
 * Entidad Paciente: SÓLO datos clínicos, referenciados por el código anónimo
 * (`DEMO-002`, `DEMO-005`, ...). Los datos personales identificatorios (nombre,
 * correo, teléfono) viven en el perfil de usuario y se combinan únicamente en
 * la capa de presentación mediante el DTO `PatientView` (minimización de datos,
 * Ley 25.326). El DNI es opcional y no se muestra en listados.
 */
class Patient {
  constructor(p) {
    this.id = p.id;
    this.userId = p.userId || null;
    this.medicoId = p.medicoId;
    this.codigo = p.codigo;
    this.dni = p.dni || null;
    this.fechaNacimiento = p.fechaNacimiento;
    this.sexo = p.sexo;
    this.centro = p.centro || null;
    this.tipoDm = p.tipoDm;
    this.aniosEvolucionDm = numOrNull(p.aniosEvolucionDm);
    this.insulinorequiriente = Boolean(p.insulinorequiriente);
    this.hba1c = numOrNull(p.hba1c);
    this.hba1cFecha = p.hba1cFecha || null;
    this.hba1cImputada = Boolean(p.hba1cImputada);
    this.hba1cNota = p.hba1cNota || null;
    this.tabaquismo = triState(p.tabaquismo);
    this.neuropatia = Boolean(p.neuropatia);
    this.neuropatiaPuntaje = numOrNull(p.neuropatiaPuntaje);
    this.vibratoriaDer = numOrNull(p.vibratoriaDer);
    this.vibratoriaDerMas50 = Boolean(p.vibratoriaDerMas50);
    this.vibratoriaIzq = numOrNull(p.vibratoriaIzq);
    this.vibratoriaIzqMas50 = Boolean(p.vibratoriaIzqMas50);
    this.ulceraPreviaDer = Boolean(p.ulceraPreviaDer);
    this.ulceraPreviaIzq = Boolean(p.ulceraPreviaIzq);
    this.isquemia = Boolean(p.isquemia);
    this.ampollas = Boolean(p.ampollas);
    this.hiperqueratosis = Boolean(p.hiperqueratosis);
    this.hiperqueratosisLocalizacion = p.hiperqueratosisLocalizacion || null;
    this.eritema = Boolean(p.eritema);
    this.hematomas = Boolean(p.hematomas);
    // Campos previstos para etapas futuras del estudio.
    this.indiceTobilloBrazo = numOrNull(p.indiceTobilloBrazo);
    this.pesoKg = numOrNull(p.pesoKg);
    this.cirugiasPrevias = p.cirugiasPrevias || null;
    this.patologiasPrevias = p.patologiasPrevias || null;
    this.observaciones = p.observaciones || null;
    this.exclusion = Object.fromEntries(EXCLUSION_KEYS.map((k) => [k, Boolean(p.exclusion?.[k])]));
    // Estado vigente del consentimiento (el historial está en Consent).
    this.consentimientoFirmado = Boolean(p.consentimientoFirmado);
    this.consentimientoFecha = p.consentimientoFecha || null;
    // Desenlace del seguimiento: ¿generó lesión? (null = sin registrar).
    this.generoLesion = triState(p.generoLesion);
    this.lesionFecha = p.lesionFecha || null;
    this.lesionPie = p.lesionPie || null;
    this.lesionRoi = p.lesionRoi || null;
    this.lesionNotas = p.lesionNotas || null;
    this.createdAt = p.createdAt || new Date().toISOString();
    this.updatedAt = p.updatedAt || this.createdAt;
  }

  edad(ref = new Date()) {
    if (!this.fechaNacimiento) return null;
    const b = new Date(this.fechaNacimiento);
    let age = ref.getFullYear() - b.getFullYear();
    const m = ref.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && ref.getDate() < b.getDate())) age -= 1;
    return age;
  }

  get gradoNeuropatia() {
    if (!this.neuropatia) return 'Normal';
    return neuropathyGrade(this.neuropatiaPuntaje);
  }

  get vibratoriaDerAlterada() {
    return this.vibratoriaDerMas50 || (this.vibratoriaDer !== null && this.vibratoriaDer > VIBRATORIA_CORTE);
  }

  get vibratoriaIzqAlterada() {
    return this.vibratoriaIzqMas50 || (this.vibratoriaIzq !== null && this.vibratoriaIzq > VIBRATORIA_CORTE);
  }

  /** HbA1c desactualizada (>12 meses), sin fecha o imputada: se marca en la interfaz. */
  hba1cAlerta(ref = new Date()) {
    if (this.hba1c === null) return 'sin_dato';
    if (this.hba1cImputada) return 'imputada';
    if (!this.hba1cFecha) return 'sin_fecha';
    const d = new Date(this.hba1cFecha);
    const meses = (ref.getFullYear() - d.getFullYear()) * 12 + (ref.getMonth() - d.getMonth());
    return meses > HBA1C_MAX_MESES ? 'desactualizada' : null;
  }

  get excluido() {
    return Object.values(this.exclusion).some(Boolean);
  }

  get antecedenteUlcera() {
    return this.ulceraPreviaDer || this.ulceraPreviaIzq;
  }

  get desenlaceRegistrado() {
    return this.generoLesion !== null;
  }
}

Patient.EXCLUSION_KEYS = EXCLUSION_KEYS;
/** Campos personales que NO pertenecen a la entidad clínica. */
Patient.PERSONAL_FIELDS = Object.freeze(['nombre', 'apellido', 'email', 'telefono']);

module.exports = Patient;
