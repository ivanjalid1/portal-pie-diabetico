'use strict';

/**
 * Constantes del dominio clínico (protocolo de la Parte 1 del Proyecto Integrador:
 * "Correlación entre la termografía y la predicción de úlceras en pie diabético").
 *
 * Centralizar estos valores permite ajustar el protocolo (por ejemplo, qué dos
 * imágenes se cargan en cada estudio) sin tocar controladores ni vistas.
 */

/**
 * Las dos imágenes que recibe el análisis. La elección definitiva puede cambiar,
 * por eso se definen presets y se elige uno con la variable IMAGE_SLOTS_PRESET:
 *  - 'termica_visible' (por defecto): termografía + imagen visible / IR-Fusion.
 *  - 'toma1_toma2': termografía basal + termografía de seguimiento (30–45 días).
 */
const IMAGE_SLOT_PRESETS = Object.freeze({
  termica_visible: Object.freeze([
    Object.freeze({
      slot: 'termografia',
      orden: 1,
      titulo: 'Imagen 1 · Termografía plantar',
      corto: 'termografía plantar',
      descripcion: 'Imagen infrarroja de ambos pies en una sola toma (Fluke TiS75, 320×240 px).',
    }),
    Object.freeze({
      slot: 'visible',
      orden: 2,
      titulo: 'Imagen 2 · Imagen visible / IR-Fusion',
      corto: 'imagen visible / IR-Fusion',
      descripcion: 'Fotografía visible o IR-Fusion de la misma toma (cámara visible de 5 MP).',
    }),
  ]),
  toma1_toma2: Object.freeze([
    Object.freeze({
      slot: 'termografia',
      orden: 1,
      titulo: 'Imagen 1 · Termografía basal (toma 1)',
      corto: 'termografía basal',
      descripcion: 'Termografía plantar de ambos pies en la toma basal.',
    }),
    Object.freeze({
      slot: 'visible',
      orden: 2,
      titulo: 'Imagen 2 · Termografía de seguimiento (toma 2)',
      corto: 'termografía de seguimiento',
      descripcion: 'Termografía plantar de ambos pies a los 30–45 días.',
    }),
  ]),
});

const IMAGE_SLOTS = IMAGE_SLOT_PRESETS[process.env.IMAGE_SLOTS_PRESET] || IMAGE_SLOT_PRESETS.termica_visible;

/**
 * Formatos aceptados. Además de JPG/PNG/TIFF se admite el archivo nativo de
 * la cámara Fluke (.IS2): un ZIP que contiene IR.data (matriz 320×241 uint16)
 * y las imágenes visibles en JPG. Por ahora sólo se almacena; su decodificación
 * se describe en docs/despliegue.md (sección «Conectar el algoritmo real»).
 */
const ACCEPTED_IMAGE_TYPES = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/tiff': 'tif',
  'application/x-fluke-is2': 'is2',
});

/** Tipos que el navegador puede mostrar como vista previa. */
const PREVIEWABLE_TYPES = Object.freeze(['image/jpeg', 'image/png']);

/** Regiones de interés: 6 por pie + general. */
const ROIS = Object.freeze([
  Object.freeze({ key: 'dedo_mayor', nombre: 'Dedo mayor', csv: 'DEDO MAYOR' }),
  Object.freeze({ key: 'dedos_menores', nombre: 'Dedos menores', csv: 'DEDOS MENORES' }),
  Object.freeze({ key: 'metatarso', nombre: 'Metatarso', csv: 'METATARSO' }),
  Object.freeze({ key: 'arco_interno', nombre: 'Arco interno', csv: 'ARCO INTERNO' }),
  Object.freeze({ key: 'arco_externo', nombre: 'Arco externo', csv: 'ARCO EXTERNO' }),
  Object.freeze({ key: 'talon', nombre: 'Talón', csv: 'TALÓN' }),
  Object.freeze({ key: 'general', nombre: 'General', csv: 'GENERAL' }),
]);

const ROI_NAMES = Object.freeze(Object.fromEntries(ROIS.map((r) => [r.key, r.nombre])));

/**
 * Umbral de asimetría contralateral (|ΔT| en °C), configurable con
 * ASYMMETRY_THRESHOLD:
 *  - 1,0 °C (por defecto): criterio de la solicitud del PI y de la planilla
 *    del equipo para clasificar el grupo térmico P/C.
 *  - 2,2 °C: valor de referencia de la literatura.
 */
const THRESHOLD_OPTIONS = Object.freeze([
  Object.freeze({ value: 1.0, nombre: '1,0 °C', fuente: 'Solicitud del PI / planilla del equipo' }),
  Object.freeze({ value: 2.2, nombre: '2,2 °C', fuente: 'Referencia bibliográfica' }),
]);

function parseThreshold(v) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n < 10 ? n : 1.0;
}

const DELTA_T_UMBRAL = parseThreshold(process.env.ASYMMETRY_THRESHOLD);

/** Valor de referencia bibliográfica (se informa junto al umbral activo). */
const DELTA_T_REFERENCIA = 2.2;

/** «Simétrico»: |ΔT general| < 1 °C. */
const SIMETRIA_CORTE = 1.0;

/**
 * Grupo térmico. Todos los participantes son diabéticos: «C» no significa
 * sujeto sano sino «sin asimetría por encima del umbral».
 */
const GRUPOS_TERMICOS = Object.freeze({
  P: Object.freeze({ key: 'P', nombre: 'P (Problema)', descripcion: 'Al menos una ROI con |ΔT| ≥ umbral' }),
  C: Object.freeze({ key: 'C', nombre: 'C (Control)', descripcion: 'Ninguna ROI supera el umbral' }),
});

/** Clasificación térmica de un conjunto de ROIs. */
function thermalGroup(rois, umbral = DELTA_T_UMBRAL) {
  const regionales = rois.filter((r) => r.roi !== 'general');
  const general = rois.find((r) => r.roi === 'general');
  const grupo = regionales.some((r) => Math.abs(r.deltaT) >= umbral) ? 'P' : 'C';
  const simetrico = general ? Math.abs(general.deltaT) < SIMETRIA_CORTE : null;
  return { grupo, simetrico };
}

/** Puntos de corte de probabilidad (%) para la categoría de riesgo. */
const RISK_CUTS = Object.freeze({ moderado: 50, alto: 70 });

const RISK_CATEGORIES = Object.freeze({
  sin_riesgo: Object.freeze({
    key: 'sin_riesgo',
    nombre: 'Sin riesgo',
    tono: 'ok',
    paciente: 'Riesgo bajo',
    mensajePaciente:
      'Tu control no mostró señales de alerta. Seguí con los cuidados diarios y asistí al próximo control.',
  }),
  moderado: Object.freeze({
    key: 'moderado',
    nombre: 'Riesgo moderado',
    tono: 'warn',
    paciente: 'Requiere atención',
    mensajePaciente:
      'Tu control mostró algunas diferencias de temperatura entre los pies. Reforzá los cuidados diarios y respetá la fecha del próximo control.',
  }),
  alto: Object.freeze({
    key: 'alto',
    nombre: 'Alto riesgo',
    tono: 'danger',
    paciente: 'Seguimiento prioritario',
    mensajePaciente:
      'Tu médico va a hacer un seguimiento más cercano. Revisá tus pies todos los días y consultá ante cualquier cambio.',
  }),
});

function categoryFor(probabilidad) {
  if (probabilidad >= RISK_CUTS.alto) return 'alto';
  if (probabilidad >= RISK_CUTS.moderado) return 'moderado';
  return 'sin_riesgo';
}

const HORIZONTE_SEMANAS = 6;

/** Tomas del protocolo. */
const TOMAS = Object.freeze([
  Object.freeze({ value: 1, nombre: 'Toma 1 · Basal' }),
  Object.freeze({ value: 2, nombre: 'Toma 2 · Seguimiento (30–45 días)' }),
]);

/**
 * Centros participantes y prefijo del código anónimo del paciente.
 * SUPUESTO: la correspondencia prefijo ↔ centro se infirió de los formatos
 * P.HC###, P.RF### y P.VHF###; se puede corregir aquí sin tocar el resto.
 */
const CENTROS = Object.freeze([
  Object.freeze({ nombre: 'Hospital Córdoba', prefijo: 'HC' }),
  Object.freeze({ nombre: 'Hospital Ferreyra', prefijo: 'VHF' }),
  Object.freeze({ nombre: 'Clínica Reina Fabiola', prefijo: 'RF' }),
  Object.freeze({ nombre: 'Hospital de Clínicas', prefijo: 'HNC' }),
]);

const CENTRO_NOMBRES = Object.freeze(CENTROS.map((c) => c.nombre));

function prefijoCentro(centro) {
  return CENTROS.find((c) => c.nombre === centro)?.prefijo || 'HC';
}

/** Código anónimo: P.<prefijo><3 dígitos>. */
const CODIGO_REGEX = /^P\.[A-Z]{2,4}\d{3}$/;

/** Condiciones de adquisición del protocolo. */
const ACQUISITION = Object.freeze({
  tempAmbiente: Object.freeze({ min: 21, max: 24, unidad: '°C' }),
  humedadRelativa: Object.freeze({ min: 40, max: 70, unidad: '%' }),
  distanciaCm: 80,
  emisividad: 0.98,
  rango: Object.freeze({ min: 24, max: 35 }),
  paletas: Object.freeze(['Ironbow', 'Arcoíris', 'Escala de grises', 'Ámbar']),
  fondos: Object.freeze(['Cartulina', 'Tela']),
  tiempoEstabilizacionMin: 15,
  camara: 'Fluke TiS75 (320×240, IR-Fusion)',
});

/** Checklist previa a la captura que el médico confirma en el asistente. */
const CAPTURE_CHECKLIST = Object.freeze([
  Object.freeze({ key: 'sin_calzado', texto: 'Paciente descalzo y sin medias durante el tiempo de estabilización' }),
  Object.freeze({ key: 'decubito', texto: 'Paciente en decúbito dorsal con ambos pies en el mismo plano' }),
  Object.freeze({ key: 'sin_cremas', texto: 'Sin cremas ni humedad visible en la planta' }),
  Object.freeze({ key: 'enfoque', texto: 'Cámara enfocada, emisividad 0,98 y rango 24–35 °C' }),
  Object.freeze({ key: 'fondo', texto: 'Fondo uniforme (cartulina o tela) y sin fuentes de calor cercanas' }),
]);

/** Criterios de exclusión del protocolo (cualquiera excluye al paciente). */
const EXCLUSION_CRITERIA = Object.freeze([
  Object.freeze({ key: 'muletasProtesis', texto: 'Usa muletas o prótesis' }),
  Object.freeze({ key: 'deterioroCognitivo', texto: 'Deterioro cognitivo que impide el seguimiento' }),
  Object.freeze({ key: 'artritisCharcotTrauma', texto: 'Artritis inflamatoria, pie de Charcot o trauma reciente' }),
  Object.freeze({ key: 'noCamina100m', texto: 'No puede caminar 100 m' }),
  Object.freeze({ key: 'ulcerasActivas', texto: 'Úlceras activas en los pies' }),
  Object.freeze({ key: 'pesoMayor150', texto: 'Peso mayor a 150 kg' }),
]);

/** Grado de neuropatía según puntaje (0–10). */
function neuropathyGrade(puntaje) {
  if (puntaje === null || puntaje === undefined || Number.isNaN(Number(puntaje))) return 'Normal';
  const p = Number(puntaje);
  if (p <= 0) return 'Normal';
  if (p <= 2) return 'Leve';
  if (p <= 5) return 'Moderada';
  return 'Grave';
}

const NEUROPATHY_GRADES = Object.freeze(['Normal', 'Leve', 'Moderada', 'Grave']);

/** Percepción vibratoria (µV): escala 0–50 con opción «>50»; ≤30 conservada, >30 alterada. */
const VIBRATORIA_CORTE = 30;
const VIBRATORIA_MAX = 50;

/** HbA1c con más de 12 meses de antigüedad se marca como desactualizada. */
const HBA1C_MAX_MESES = 12;

/** Versión vigente del documento de consentimiento informado. */
const CONSENT_VERSION = 'CI-PI-2026 v1.0';

/** Ficha del modelo de referencia obtenido en la Parte 1. */
const REFERENCE_MODEL = Object.freeze({
  nombre: 'Regresión Logística',
  hiperparametros: 'C = 0,5',
  validacion: 'Leave-One-Out (LOO)',
  n: 67,
  auc: 0.745,
  sensibilidad: 81.4,
  especificidad: 50.0,
  vpp: 74.5,
  vpn: 60.0,
  fuente:
    'Parte 1: «Correlación entre la termografía y la predicción de úlceras en pie diabético» (Muñoz A. P., FCEFyN – UNC)',
});

/** Datos institucionales del Proyecto Integrador (Parte 2). */
const PROJECT = Object.freeze({
  titulo:
    'Procesamiento de imágenes y análisis punto a punto de termogramas plantares para la detección temprana del riesgo de pie diabético',
  alumna: 'María Inés Greising Revol',
  asesor: 'Conrado J. Rodríguez',
  coasesoras: Object.freeze([
    'Dra. María Ranz y Álvarez',
    'Dra. María Eugenia Lozano',
    'Dra. Beatriz Alejandra García',
  ]),
  carrera: 'Ingeniería Biomédica',
  facultad: 'Facultad de Ciencias Exactas, Físicas y Naturales',
  universidad: 'Universidad Nacional de Córdoba',
  anio: 2026,
  antecedente:
    'Parte 1: «Correlación entre la termografía y la predicción de úlceras en pie diabético», Ana Paula Muñoz (FCEFyN – UNC).',
});

const DISCLAIMER =
  'Herramienta exploratoria complementaria, no diagnóstica. Resultado simulado (mockup) — el algoritmo de procesamiento de imágenes está en desarrollo.';

/** Alias histórico: lista de centros para los formularios. */
const INSTITUCIONES = CENTRO_NOMBRES;

module.exports = {
  IMAGE_SLOT_PRESETS,
  IMAGE_SLOTS,
  ACCEPTED_IMAGE_TYPES,
  PREVIEWABLE_TYPES,
  ROIS,
  ROI_NAMES,
  THRESHOLD_OPTIONS,
  DELTA_T_UMBRAL,
  DELTA_T_REFERENCIA,
  SIMETRIA_CORTE,
  GRUPOS_TERMICOS,
  thermalGroup,
  parseThreshold,
  RISK_CUTS,
  RISK_CATEGORIES,
  categoryFor,
  HORIZONTE_SEMANAS,
  TOMAS,
  CENTROS,
  CENTRO_NOMBRES,
  prefijoCentro,
  CODIGO_REGEX,
  ACQUISITION,
  CAPTURE_CHECKLIST,
  EXCLUSION_CRITERIA,
  neuropathyGrade,
  NEUROPATHY_GRADES,
  VIBRATORIA_CORTE,
  VIBRATORIA_MAX,
  HBA1C_MAX_MESES,
  CONSENT_VERSION,
  REFERENCE_MODEL,
  PROJECT,
  DISCLAIMER,
  INSTITUCIONES,
};
