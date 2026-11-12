'use strict';

const { ROIS } = require('../config/domain');

/**
 * Exportación CSV con las mismas columnas que la planilla del equipo de
 * investigación. Separador `;` y coma decimal para abrirse directamente en
 * Excel/LibreOffice con configuración regional es-AR. Sólo incluye el código
 * anónimo del paciente (sin nombre, correo ni DNI).
 */

const yesNo = (v) => (v === null || v === undefined ? '' : v ? 'SI' : 'NO');
const num = (v, d = 2) =>
  v === null || v === undefined || Number.isNaN(Number(v)) ? '' : Number(v).toFixed(d).replace('.', ',');

function vib(value, mas50) {
  if (mas50) return '>50';
  return value === null || value === undefined ? '' : num(value, 0);
}

function escape(value) {
  const s = String(value ?? '');
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const BASE_COLUMNS = [
  ['ID PACIENTE', ({ patient }) => patient.codigo],
  ['EDAD', ({ patient, study }) => patient.edad(study ? new Date(study.fechaHora) : new Date()) ?? ''],
  ['SEXO', ({ patient }) => patient.sexo],
  ['AÑOS DE PREEXISTENCIA DE DIABETES', ({ patient }) => num(patient.aniosEvolucionDm, 1)],
  ['TIPO DE DIABETES', ({ patient }) => patient.tipoDm],
  ['INSULINO REQUIRIENTE', ({ patient }) => yesNo(patient.insulinorequiriente)],
  ['HbA1c', ({ patient }) => num(patient.hba1c, 1)],
  ['TABAQUISMO', ({ patient }) => (patient.tabaquismo === null ? 'A CONSULTAR' : yesNo(patient.tabaquismo))],
  ['NEUROPATIA', ({ patient }) => yesNo(patient.neuropatia)],
  ['GRADO DE NEUROPATÍA', ({ patient }) => patient.gradoNeuropatia.toUpperCase()],
  ['VIBRATORIA PIE DERECHO', ({ patient }) => vib(patient.vibratoriaDer, patient.vibratoriaDerMas50)],
  ['VIBRATORIA PIE IZQUIERDO', ({ patient }) => vib(patient.vibratoriaIzq, patient.vibratoriaIzqMas50)],
  ['ANTECEDENTES DE ULCERAS PIE DERECHO', ({ patient }) => yesNo(patient.ulceraPreviaDer)],
  ['ANTECEDENTES DE ULCERAS PIE IZQUIERDO', ({ patient }) => yesNo(patient.ulceraPreviaIzq)],
  ['ISQUEMIA', ({ patient }) => yesNo(patient.isquemia)],
  ['AMPOLLAS', ({ patient }) => yesNo(patient.ampollas)],
  ['HIPERQUERATOSIS', ({ patient }) => yesNo(patient.hiperqueratosis)],
  ['ERITEMAS', ({ patient }) => yesNo(patient.eritema)],
  ['HEMATOMAS', ({ patient }) => yesNo(patient.hematomas)],
  ['GENERÓ LESIÓN', ({ patient }) => yesNo(patient.generoLesion)],
];

const ROI_COLUMNS = ROIS.flatMap((r) => [
  [`AVG DER ${r.csv}`, ({ analysis }) => num(analysis?.roi(r.key)?.avgDer)],
  [`AVG IZQ ${r.csv}`, ({ analysis }) => num(analysis?.roi(r.key)?.avgIzq)],
  [`DIF REG ${r.csv}`, ({ analysis }) => num(analysis?.roi(r.key)?.deltaT)],
]);

const TAIL_COLUMNS = [
  ['GRUPO (P/C)', ({ analysis }) => analysis?.grupo || ''],
  ['SIMETRICO', ({ analysis }) => yesNo(analysis?.simetrico)],
  // Columnas adicionales del portal (no están en la planilla original).
  ['TOMA', ({ study }) => study?.toma ?? ''],
  ['FECHA ESTUDIO', ({ study }) => (study ? study.fechaHora.slice(0, 10) : '')],
  ['UMBRAL ΔT (°C)', ({ analysis }) => num(analysis?.umbral, 1)],
];

const COLUMNS = [...BASE_COLUMNS, ...ROI_COLUMNS, ...TAIL_COLUMNS];

function buildCsv(rows) {
  const lines = [COLUMNS.map(([h]) => escape(h)).join(';')];
  for (const row of rows) lines.push(COLUMNS.map(([, get]) => escape(get(row))).join(';'));
  // BOM para que Excel detecte UTF-8 (tildes y ñ).
  const BOM = String.fromCharCode(0xfeff);
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

module.exports = { buildCsv, COLUMNS };
