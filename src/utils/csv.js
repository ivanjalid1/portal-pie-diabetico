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
  // Detalle del desenlace real (para entrenar un modelo de úlcera: scripts/ml/train-outcome.py).
  [
    'FECHA LESIÓN',
    ({ patient }) => (patient.generoLesion && patient.lesionFecha ? String(patient.lesionFecha).slice(0, 10) : ''),
  ],
  ['PIE LESIÓN', ({ patient }) => (patient.generoLesion ? (patient.lesionPie || '').toUpperCase() : '')],
  ['ZONA LESIÓN', ({ patient }) => (patient.generoLesion ? (patient.lesionRoi || '').toUpperCase() : '')],
];

/** Columnas por ROI y clasificación térmica de una toma (prefijo T1/T2). */
function tomaColumns(toma) {
  const p = `T${toma}`;
  const grupo = ({ analysis }) => analysis?.grupoDeToma(toma) || '';
  const sim = ({ analysis }) => yesNo(analysis?.simetricoDeToma(toma));
  const pw = (analysis) => analysis?.puntualToma(toma)?.metricas || null;
  return [
    ...ROIS.flatMap((r) => [
      [`${p} AVG DER ${r.csv}`, ({ analysis }) => num(analysis?.roi(r.key, toma)?.avgDer)],
      [`${p} AVG IZQ ${r.csv}`, ({ analysis }) => num(analysis?.roi(r.key, toma)?.avgIzq)],
      [`${p} DIF REG ${r.csv}`, ({ analysis }) => num(analysis?.roi(r.key, toma)?.deltaT)],
    ]),
    [`${p} GRUPO (P/C)`, grupo],
    [`${p} SIMETRICO`, sim],
    // Análisis punto a punto (ΔT = izquierdo − derecho espejado).
    [`${p} PUNTUAL AREA |DT|>UMBRAL (%)`, ({ analysis }) => num(pw(analysis)?.areaCalientePct, 1)],
    [`${p} PUNTUAL |DT| MEDIO`, ({ analysis }) => num(pw(analysis)?.mediaAbs)],
    [`${p} PUNTUAL |DT| P95`, ({ analysis }) => num(pw(analysis)?.p95Abs)],
    [`${p} PUNTUAL |DT| MAX`, ({ analysis }) => num(pw(analysis)?.maxAbs)],
    [
      `${p} PUNTUAL ZONAS NO ANALIZADAS`,
      ({ analysis }) => (analysis?.puntualToma(toma)?.zonasNoAnalizadas || []).join(' '),
    ],
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
  ['CORTE SIMETRIA (°C)', ({ analysis }) => num(analysis?.parametros?.corteSimetria, 1)],
  [
    'CORTES RIESGO (%)',
    ({ analysis }) => (analysis ? `${analysis.parametros.corteModerado}/${analysis.parametros.corteAlto}` : ''),
  ],
  ['UMBRAL POR PUNTO (°C)', ({ analysis }) => num(analysis?.puntual?.umbralPixel, 1)],
  // Riesgo de úlcera (calibrado con la bibliografía, o el modelo entrenado si existe).
  [
    'RIESGO ULCERA (%)',
    ({ analysis }) =>
      analysis?.puntual?.riesgo || analysis?.puntual?.riesgoEntrenado ? num(analysis.probabilidad, 2) : '',
  ],
  [
    'RIESGO ULCERA IC (%)',
    ({ analysis }) => {
      const r = analysis?.puntual?.riesgo?.rango;
      return r && !analysis.puntual.riesgoEntrenado ? `${num(r[0], 2)}-${num(r[1], 2)}` : '';
    },
  ],
  ['HORIZONTE (SEMANAS)', ({ analysis }) => analysis?.puntual?.riesgo?.horizonteSemanas ?? ''],
  [
    'HORIZONTE (MESES)',
    ({ analysis }) => {
      const s = analysis?.puntual?.riesgo?.horizonteSemanas;
      return Number.isFinite(s) ? num((s * 12) / 52, 1) : '';
    },
  ],
  ['GRUPO IWGDF', ({ analysis }) => analysis?.puntual?.riesgo?.grupoIwgdf ?? ''],
  // Neuropatía estimada por la CNN entrenada con la cohorte (§8.10); define el prior sólo sin dato clínico.
  ['NEUROPATIA MODELO (%)', ({ analysis }) => num(analysis?.puntual?.factorRiesgo?.probabilidad, 1)],
  ['CATEGORIA RIESGO', ({ analysis }) => analysis?.categoria || ''],
  [
    'MODELO RIESGO',
    ({ analysis }) =>
      analysis?.puntual?.riesgoEntrenado
        ? analysis.puntual.riesgoEntrenado.version
        : analysis?.puntual?.riesgo?.version || '',
  ],
  // Patrón térmico compatible con pie diabético (modelo de la base pública 2019,
  // diabetes vs control). NO es una probabilidad de úlcera.
  ['PATRON PIE DIABETICO (%) BASE PUBLICA', ({ analysis }) => num(analysis?.puntual?.patronDm?.probabilidad, 1)],
  ['MODELO PATRON', ({ analysis }) => analysis?.puntual?.patronDm?.version || ''],
  // Pronóstico por zona del próximo control (ThermalForecastService, §8.11): la zona
  // con mayor área caliente esperada. Vacío sin modelo local (CI, Vercel).
  ['PRONOSTICO ZONA', ({ forecast }) => (forecast?.peor ? forecast.peor.texto.toUpperCase() : '')],
  ['PRONOSTICO AREA ACTUAL (%)', ({ forecast }) => num(forecast?.peor?.actual, 1)],
  ['PRONOSTICO AREA ESPERADA (%)', ({ forecast }) => num(forecast?.peor?.esperado, 1)],
  [
    'PRONOSTICO RANGO 80 (%)',
    ({ forecast }) => (forecast?.peor ? `${num(forecast.peor.rango[0], 1)}-${num(forecast.peor.rango[1], 1)}` : ''),
  ],
  ['PRONOSTICO PROB CALIENTE (%)', ({ forecast }) => num(forecast?.peor ? forecast.peor.prob * 100 : null, 1)],
  // Zona con área caliente ≥ área mínima en la toma 1 y en la toma 2 (no usa el modelo).
  [
    'ZONA CALIENTE PERSISTENTE',
    ({ forecast }) => (forecast && forecast.tomas >= 2 ? (forecast.persistentes.length ? 'SI' : 'NO') : ''),
  ],
  // Criterio IWGDF / Lavery: p95 del ΔT de la zona ≥ 2,2 °C en ambas tomas (mismo pie más caliente).
  [
    'ALERTA IWGDF 2,2 °C PERSISTENTE',
    ({ forecast }) => (forecast && forecast.tomas >= 2 ? (forecast.alertas.length ? 'SI' : 'NO') : ''),
  ],
  [
    'ZONAS ALERTA IWGDF',
    ({ forecast }) => (forecast ? forecast.alertas.map((z) => z.texto.toUpperCase()).join(' / ') : ''),
  ],
  [
    'ZONAS PERSISTENTES',
    ({ forecast }) => (forecast ? forecast.persistentes.map((z) => z.texto.toUpperCase()).join(' / ') : ''),
  ],
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
    ['GRUPO T1', ({ analysis }) => analysis?.grupoDeToma(1) || ''],
    ['GRUPO T2', ({ analysis }) => analysis?.grupoDeToma(2) || ''],
    ['PUNTUAL AREA |DT|>UMBRAL (%)', ({ analysis }) => num(analysis?.puntualActual?.metricas?.areaCalientePct, 1)],
    ['RIESGO ULCERA (%)', ({ analysis }) => (analysis?.puntual?.riesgo ? num(analysis.probabilidad, 2) : '')],
    ['PATRON PIE DIABETICO (%) BASE PUBLICA', ({ analysis }) => num(analysis?.puntual?.patronDm?.probabilidad, 1)],
    ['GENERÓ LESIÓN', ({ patient }) => yesNo(patient.generoLesion)],
  ];
  const lines = [cols.map(([h]) => escape(h)).join(';')];
  for (const item of items) lines.push(cols.map(([, get]) => escape(get(item))).join(';'));
  const BOM = String.fromCharCode(0xfeff);
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

module.exports.buildControlesCsv = buildControlesCsv;
