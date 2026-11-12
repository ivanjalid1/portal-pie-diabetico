'use strict';

/**
 * Mappers (patrón DTO/Mapper) entre las entidades del dominio (camelCase) y
 * las filas de Postgres (snake_case). Cada tabla declara sus columnas para
 * no enviar nunca propiedades desconocidas (p. ej. getters o campos de vista).
 */

const toSnake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toCamel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

const COLUMNS = {
  profiles: [
    'id',
    'email',
    'role',
    'nombre',
    'apellido',
    'telefono',
    'activo',
    'mustChangePassword',
    'matricula',
    'especialidad',
    'institucion',
    'createdAt',
    'lastLoginAt',
  ],
  patients: [
    'id',
    'userId',
    'medicoId',
    'codigo',
    'dni',
    'fechaNacimiento',
    'sexo',
    'centro',
    'tipoDm',
    'aniosEvolucionDm',
    'insulinorequiriente',
    'hba1c',
    'hba1cFecha',
    'hba1cImputada',
    'hba1cNota',
    'tabaquismo',
    'neuropatia',
    'neuropatiaPuntaje',
    'vibratoriaDer',
    'vibratoriaDerMas50',
    'vibratoriaIzq',
    'vibratoriaIzqMas50',
    'ulceraPreviaDer',
    'ulceraPreviaIzq',
    'isquemia',
    'ampollas',
    'hiperqueratosis',
    'hiperqueratosisLocalizacion',
    'eritema',
    'hematomas',
    'indiceTobilloBrazo',
    'pesoKg',
    'cirugiasPrevias',
    'patologiasPrevias',
    'observaciones',
    'exclusion',
    'consentimientoFirmado',
    'consentimientoFecha',
    'generoLesion',
    'lesionFecha',
    'lesionPie',
    'lesionRoi',
    'lesionNotas',
    'createdAt',
  ],
  consents: ['id', 'patientId', 'version', 'fechaFirma', 'registradoPor', 'revocadoAt', 'motivoRevocacion', 'notas', 'createdAt'],
  studies: [
    'id',
    'patientId',
    'medicoId',
    'fechaHora',
    'fechaToma1',
    'toma1OrigenStudyId',
    'tempAmbienteToma1',
    'humedadRelativaToma1',
    'centro',
    'tempAmbiente',
    'humedadRelativa',
    'distanciaCm',
    'emisividad',
    'rangoMin',
    'rangoMax',
    'paleta',
    'tiempoEstabilizacionMin',
    'fondo',
    'valida',
    'motivoInvalidez',
    'checklist',
    'estado',
    'notasMedico',
    'publicado',
    'publicadoAt',
    'createdAt',
  ],
  study_images: ['id', 'studyId', 'slot', 'storagePath', 'publicUrl', 'mime', 'size', 'originalName'],
  analysis_results: [
    'id',
    'studyId',
    'predictorVersion',
    'fuenteRois',
    'deltaTMax',
    'deltaTMaxRoi',
    'deltaTMaxToma1',
    'deltaTMaxRoiToma1',
    'grupoToma1',
    'simetricoToma1',
    'umbral',
    'grupo',
    'simetrico',
    'probabilidad',
    'categoria',
    'horizonteSemanas',
    'factores',
    'simulado',
    'createdAt',
  ],
  roi_mediciones: ['analysisId', 'toma', 'roi', 'avgDer', 'avgIzq', 'maxDer', 'maxIzq', 'minDer', 'minIzq', 'deltaT'],
  appointments: [
    'id',
    'patientId',
    'medicoId',
    'studyId',
    'origenStudyId',
    'fecha',
    'motivo',
    'estado',
    'realizadoEn',
    'motivoAusencia',
    'createdAt',
  ],
  audit_log: ['id', 'actorId', 'actorEmail', 'action', 'entity', 'entityId', 'detail', 'ip', 'createdAt'],
};

/** Nombres de columna que no siguen la conversión automática. */
const SPECIAL = {
  study_images: { size: 'size_bytes' },
  roi_mediciones: { deltaT: 'dt' },
  analysis_results: { deltaTMax: 'delta_t_max', deltaTMaxRoi: 'delta_t_max_roi' },
  patients: { hba1c: 'hba1c', hba1cFecha: 'hba1c_fecha', hba1cImputada: 'hba1c_imputada', hba1cNota: 'hba1c_nota' },
};

function column(table, key) {
  return SPECIAL[table]?.[key] || toSnake(key);
}

/** Entidad/objeto → fila (sólo columnas declaradas y definidas). */
function toRow(table, obj) {
  const row = {};
  for (const key of COLUMNS[table]) {
    if (obj[key] !== undefined) row[column(table, key)] = obj[key];
  }
  return row;
}

const RELATIONS = ['study_images', 'roi_mediciones'];

/** Fila → objeto plano en camelCase. */
function fromRow(table, row) {
  if (!row) return null;
  const inverse = Object.fromEntries(Object.entries(SPECIAL[table] || {}).map(([k, v]) => [v, k]));
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (RELATIONS.includes(k)) continue; // relaciones anidadas (se mapean aparte)
    out[inverse[k] || toCamel(k)] = v;
  }
  return out;
}

module.exports = { toRow, fromRow, column, COLUMNS, toSnake, toCamel };
