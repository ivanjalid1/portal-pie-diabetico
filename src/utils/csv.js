'use strict';

const { ROIS } = require('../config/domain');

/**
 * Exportación CSV con las columnas de la planilla del equipo de investigación,
 * repetidas para la toma 1 (T1) y la toma 2 (T2), más la variación entre tomas.
 * Separador `;` y coma decimal para abrirse directamente en
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

/** Columnas por ROI y clasificación térmica de una toma (prefijo T1/T2). */
function tomaColumns(toma) {
  const p = `T${toma}`;
  const grupo = ({ analysis }) => (toma === 1 ? analysis?.grupoToma1 : analysis?.grupo) || '';
  const sim = ({ analysis }) => yesNo(toma === 1 ? analysis?.simetricoToma1 : analysis?.simetrico);
  return [
    ...ROIS.flatMap((r) => [
      [`${p} AVG DER ${r.csv}`, ({ analysis }) => num(analysis?.roi(r.key, toma)?.avgDer)],
      [`${p} AVG IZQ ${r.csv}`, ({ analysis }) => num(analysis?.roi(r.key, toma)?.avgIzq)],
      [`${p} DIF REG ${r.csv}`, ({ analysis }) => num(analysis?.roi(r.key, toma)?.deltaT)],
    ]),
    [`${p} GRUPO (P/C)`, grupo],
    [`${p} SIMETRICO`, sim],
  ];
}

/** Variación de la asimetría entre tomas: |ΔT T2| − |ΔT T1| por ROI. */
const EVOLUTION_COLUMNS = ROIS.map((r) => [
  `VARIACION |DIF| ${r.csv}`,
  ({ analysis }) => num(analysis?.evolucion.find((e) => e.roi === r.key)?.cambio),
]);

const TAIL_COLUMNS = [
  // Columnas adicionales del portal (no están en la planilla original).
  ['FECHA TOMA 1', ({ study }) => (study?.fechaToma1 ? study.fechaToma1.slice(0, 10) : '')],
  ['FECHA TOMA 2', ({ study }) => (study ? study.fechaHora.slice(0, 10) : '')],
  ['DIAS ENTRE TOMAS', ({ study }) => study?.diasEntreTomas ?? ''],
  ['UMBRAL ΔT (°C)', ({ analysis }) => num(analysis?.umbral, 1)],
  ['PROBABILIDAD (%) SIMULADA', ({ analysis }) => num(analysis?.probabilidad, 1)],
];

const COLUMNS = [...BASE_COLUMNS, ...tomaColumns(1), ...tomaColumns(2), ...EVOLUTION_COLUMNS, ...TAIL_COLUMNS];

function buildCsv(rows) {
  const lines = [COLUMNS.map(([h]) => escape(h)).join(';')];
  for (const row of rows) lines.push(COLUMNS.map(([, get]) => escape(get(row))).join(';'));
  // BOM para que Excel detecte UTF-8 (tildes y ñ).
  const BOM = String.fromCharCode(0xfeff);
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

module.exports = { buildCsv, COLUMNS };

/** CSV de controles (vista «Controles» del médico). Sólo códigos anónimos. */
function buildControlesCsv(items) {
  const cols = [
    ['ID PACIENTE', ({ patient }) => patient.codigo],
    ['ESTADO', ({ appt }) => appt.estado.toUpperCase()],
    ['FECHA PROGRAMADA', ({ appt }) => String(appt.fecha).slice(0, 10)],
    ['FECHA REALIZADO', ({ appt }) => (appt.realizadoEn ? appt.realizadoEn.slice(0, 10) : '')],
    ['DESVIO (DIAS)', ({ appt }) => appt.desvioDias ?? ''],
    ['MOTIVO', ({ appt }) => appt.motivo],
    ['MOTIVO AUSENCIA', ({ appt }) => appt.motivoAusencia || ''],
    ['GRUPO T1', ({ analysis }) => analysis?.grupoToma1 || ''],
    ['GRUPO T2', ({ analysis }) => analysis?.grupo || ''],
    ['AUMENTO MAX |DIF| (°C)', ({ analysis }) => (analysis ? num(analysis.maxEmpeoramiento) : '')],
    ['PROBABILIDAD (%) SIMULADA', ({ analysis }) => num(analysis?.probabilidad, 1)],
    ['GENERÓ LESIÓN', ({ patient }) => yesNo(patient.generoLesion)],
  ];
  const lines = [cols.map(([h]) => escape(h)).join(';')];
  for (const item of items) lines.push(cols.map(([, get]) => escape(get(item))).join(';'));
  const BOM = String.fromCharCode(0xfeff);
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

module.exports.buildControlesCsv = buildControlesCsv;
