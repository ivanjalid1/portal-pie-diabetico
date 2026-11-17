'use strict';

/**
 * Parámetros del análisis editables desde «Configuración» (médico/a y
 * administrador/a). Este módulo define cada parámetro (tipo, unidad, límites,
 * valor por defecto, ayuda y fuente documental), la validación con Zod y el
 * «snapshot» que se guarda en cada análisis para que un estudio ya calculado
 * conserve los parámetros con los que se calculó.
 */
const { z } = require('zod');

const PALETAS = Object.freeze({
  alto_contraste: 'High Contrast',
  ironbow: 'Ironbow',
  grises: 'Grises',
});

/** Nombre de la paleta de la cámara (campo del asistente) para cada paleta del visor. */
const PALETA_CAMARA = Object.freeze({
  alto_contraste: 'High Contrast',
  ironbow: 'Ironbow',
  grises: 'Escala de grises',
});

const GROUPS = Object.freeze([
  Object.freeze({
    key: 'puntual',
    titulo: 'Análisis punto a punto',
    icono: 'scan',
    descripcion: 'Umbrales del mapa de diferencias píxel a píxel entre ambos pies y entre tomas.',
  }),
  Object.freeze({
    key: 'asimetria',
    titulo: 'Referencia por regiones (Parte 1)',
    icono: 'thermo',
    descripcion: 'Clasificación por regiones de la tesis de la Parte 1, que se muestra como referencia secundaria.',
  }),
  Object.freeze({
    key: 'riesgo',
    titulo: 'Riesgo',
    icono: 'gauge',
    descripcion: 'Cortes de la probabilidad estimada y horizonte de la predicción.',
  }),
  Object.freeze({
    key: 'seguimiento',
    titulo: 'Seguimiento',
    icono: 'calendar',
    descripcion: 'Fechas sugeridas para la toma de control y el control clínico.',
  }),
  Object.freeze({
    key: 'protocolo',
    titulo: 'Protocolo de adquisición',
    icono: 'scan',
    descripcion: 'Rangos válidos de la captura. Fuera de rango se avisa en el asistente (no bloquea).',
  }),
  Object.freeze({
    key: 'visualizacion',
    titulo: 'Visualización',
    icono: 'eye',
    descripcion: 'Paleta por defecto del visor y nombres de las imágenes.',
  }),
]);

const FUENTE_PROTOCOLO = 'Protocolo de adquisición del equipo (cámara Fluke TiS75, planilla «Condiciones»)';

/**
 * Definición de parámetros. `type`: number | enum | text.
 * `presets`: valores sugeridos que se muestran como chips.
 */
const DEFINITIONS = Object.freeze([
  {
    key: 'umbralPixel',
    group: 'puntual',
    type: 'number',
    label: 'Umbral de diferencia por píxel (|ΔT|)',
    unit: '°C',
    min: 0.1,
    max: 5,
    step: 0.1,
    default: 1.0,
    help: 'Un punto del pie se considera «caliente» si la diferencia con el mismo punto del otro pie (ya registrado) supera este valor.',
    fuente: 'Mismo criterio de 1,0 °C de la solicitud del PI, aplicado a cada punto en lugar de a cada región.',
    presets: [
      { value: 1.0, label: '1,0 °C', detalle: 'Solicitud PI (criterio por región)' },
      { value: 2.2, label: '2,2 °C', detalle: 'Referencia bibliográfica' },
    ],
  },
  {
    key: 'areaMinima',
    group: 'puntual',
    type: 'number',
    label: 'Área caliente mínima para marcar asimetría',
    unit: '%',
    min: 0.5,
    max: 50,
    step: 0.5,
    default: 10,
    help: 'Una toma se marca «Con asimetría punto a punto» si al menos este porcentaje del área plantar analizada supera el umbral por píxel.',
    fuente:
      'Calibrado con la toma 1 de los 54 pacientes de la hoja «DifT°»: con 10 % se marcan 27 tomas (la Parte 1 clasificó 26 como P) y coincide en 43 de 54. A validar por el equipo.',
  },
  {
    key: 'umbralCambio',
    group: 'puntual',
    type: 'number',
    label: 'Cambio local relevante entre tomas',
    unit: '°C',
    min: 0.1,
    max: 5,
    step: 0.1,
    default: 1.0,
    help: 'En el mapa toma 1 → toma 2 de cada pie, cuenta los puntos cuyo cambio difiere en más de este valor del cambio mediano del pie (el cambio mediano refleja el ambiente y el día).',
    fuente: 'Criterio del portal (propuesta a validar con los datos del equipo).',
  },
  {
    key: 'umbralAsimetria',
    group: 'asimetria',
    type: 'number',
    label: 'Umbral de asimetría por región (|ΔT|)',
    unit: '°C',
    min: 0.1,
    max: 5,
    step: 0.1,
    default: 1.0,
    help: 'Una toma es «Con asimetría (P)» si alguna región supera este |ΔT| entre pies; si no, «Sin asimetría (C)».',
    fuente: 'Solicitud del PI de Inés (versión actual): 1,0 °C. Tesis de Ana P. Muñoz, p. 54, y Alwashmi 2025: 2,2 °C.',
    presets: [
      { value: 1.0, label: '1,0 °C', detalle: 'Solicitud PI de Inés (versión actual)' },
      { value: 2.2, label: '2,2 °C', detalle: 'Tesis Ana p. 54; Alwashmi 2025' },
    ],
  },
  {
    key: 'corteSimetria',
    group: 'asimetria',
    type: 'number',
    label: 'Corte de simetría global (|ΔT general|)',
    unit: '°C',
    min: 0.1,
    max: 5,
    step: 0.1,
    default: 1.0,
    help: 'La toma es «Simétrica» si la diferencia de temperatura media del pie completo es menor a este valor.',
    fuente: 'Planilla del equipo, hoja «DifT°», columna SIMETRICO: =IF(ABS(T−U)<1,1,0).',
  },
  {
    key: 'referenciaBibliografica',
    group: 'asimetria',
    type: 'number',
    label: 'Referencia bibliográfica (etiqueta «≥»)',
    unit: '°C',
    min: 0.1,
    max: 10,
    step: 0.1,
    default: 2.2,
    help: 'Las regiones que la superan muestran una etiqueta informativa en la tabla de temperaturas.',
    fuente: 'Tesis de Ana P. Muñoz (Parte 1), p. 54; Alwashmi 2025.',
  },
  {
    key: 'cambioRelevante',
    group: 'asimetria',
    type: 'number',
    label: 'Cambio relevante de asimetría entre tomas',
    unit: '°C',
    min: 0.05,
    max: 3,
    step: 0.05,
    default: 0.3,
    help: 'Si |ΔT| de una región cambia al menos este valor entre la toma 1 y la toma 2, se marca como aumento o mejora.',
    fuente: 'Criterio del portal para el seguimiento (propuesta del equipo, a validar con los datos).',
  },
  {
    key: 'corteModerado',
    group: 'riesgo',
    type: 'number',
    label: 'Corte de riesgo moderado',
    unit: '%',
    min: 1,
    max: 99,
    step: 1,
    default: 50,
    help: 'Desde esta probabilidad el resultado es «Riesgo moderado».',
    fuente: 'Cortes del portal sobre la probabilidad del modelo de referencia (Parte 1, Muñoz A. P.).',
  },
  {
    key: 'corteAlto',
    group: 'riesgo',
    type: 'number',
    label: 'Corte de alto riesgo',
    unit: '%',
    min: 1,
    max: 99,
    step: 1,
    default: 70,
    help: 'Desde esta probabilidad el resultado es «Alto riesgo». Debe ser mayor que el corte moderado.',
    fuente: 'Cortes del portal sobre la probabilidad del modelo de referencia (Parte 1, Muñoz A. P.).',
  },
  {
    key: 'horizonteSemanas',
    group: 'riesgo',
    type: 'number',
    label: 'Horizonte de la predicción',
    unit: 'semanas',
    min: 1,
    max: 52,
    step: 1,
    default: 6,
    help: 'Período para el que se informa la probabilidad de úlcera.',
    fuente: 'Diseño del estudio: seguimiento de 6 semanas posterior al control.',
  },
  {
    key: 'diasEntreTomas',
    group: 'seguimiento',
    type: 'number',
    label: 'Días sugeridos entre toma 1 y toma 2',
    unit: 'días',
    min: 7,
    max: 120,
    step: 1,
    default: 30,
    help: 'Se usa para sugerir la fecha de la toma de control.',
    fuente: 'Protocolo del estudio: segunda termografía unos 30 días después de la primera.',
  },
  {
    key: 'diasControl',
    group: 'seguimiento',
    type: 'number',
    label: 'Días para el control posterior al estudio',
    unit: 'días',
    min: 7,
    max: 180,
    step: 1,
    default: 42,
    help: 'Fecha sugerida para el control clínico después de la toma 2.',
    fuente: 'Diseño del estudio: control a 6 semanas (42 días).',
  },
  {
    key: 'tempAmbienteMin',
    group: 'protocolo',
    type: 'number',
    label: 'Temperatura ambiente mínima',
    unit: '°C',
    min: 10,
    max: 35,
    step: 0.5,
    default: 21,
    fuente: FUENTE_PROTOCOLO,
  },
  {
    key: 'tempAmbienteMax',
    group: 'protocolo',
    type: 'number',
    label: 'Temperatura ambiente máxima',
    unit: '°C',
    min: 10,
    max: 35,
    step: 0.5,
    default: 24,
    fuente: FUENTE_PROTOCOLO,
  },
  {
    key: 'humedadMin',
    group: 'protocolo',
    type: 'number',
    label: 'Humedad relativa mínima',
    unit: '%',
    min: 0,
    max: 100,
    step: 1,
    default: 40,
    fuente: FUENTE_PROTOCOLO,
  },
  {
    key: 'humedadMax',
    group: 'protocolo',
    type: 'number',
    label: 'Humedad relativa máxima',
    unit: '%',
    min: 0,
    max: 100,
    step: 1,
    default: 70,
    fuente: FUENTE_PROTOCOLO,
  },
  {
    key: 'distanciaCm',
    group: 'protocolo',
    type: 'number',
    label: 'Distancia de la cámara',
    unit: 'cm',
    min: 20,
    max: 300,
    step: 1,
    default: 80,
    fuente: FUENTE_PROTOCOLO,
  },
  {
    key: 'emisividad',
    group: 'protocolo',
    type: 'number',
    label: 'Emisividad',
    unit: '',
    min: 0.5,
    max: 1,
    step: 0.01,
    default: 0.98,
    fuente: FUENTE_PROTOCOLO,
  },
  {
    key: 'rangoCamaraMin',
    group: 'protocolo',
    type: 'number',
    label: 'Rango de la cámara: mínimo',
    unit: '°C',
    min: -20,
    max: 60,
    step: 1,
    default: 24,
    fuente: FUENTE_PROTOCOLO,
  },
  {
    key: 'rangoCamaraMax',
    group: 'protocolo',
    type: 'number',
    label: 'Rango de la cámara: máximo',
    unit: '°C',
    min: -20,
    max: 60,
    step: 1,
    default: 35,
    fuente: FUENTE_PROTOCOLO,
  },
  {
    key: 'estabilizacionMin',
    group: 'protocolo',
    type: 'number',
    label: 'Tiempo de estabilización',
    unit: 'min',
    min: 0,
    max: 60,
    step: 1,
    default: 15,
    fuente: FUENTE_PROTOCOLO,
  },
  {
    key: 'paletaDefecto',
    group: 'visualizacion',
    type: 'enum',
    label: 'Paleta por defecto',
    options: PALETAS,
    default: 'alto_contraste',
    help: 'Paleta con la que se abren las termografías y valor sugerido en el asistente.',
    fuente: 'High Contrast: LUT derivada de la cámara (src/config/palettes/high-contrast.json).',
  },
  {
    key: 'tituloImagen1',
    group: 'visualizacion',
    type: 'text',
    label: 'Nombre de la imagen 1',
    maxLength: 80,
    default: 'Imagen 1 · Termografía basal (toma 1)',
  },
  {
    key: 'tituloImagen2',
    group: 'visualizacion',
    type: 'text',
    label: 'Nombre de la imagen 2',
    maxLength: 80,
    default: 'Imagen 2 · Termografía de control (toma 2)',
  },
]);

const BY_KEY = Object.freeze(Object.fromEntries(DEFINITIONS.map((d) => [d.key, d])));
const DEFAULTS = Object.freeze(Object.fromEntries(DEFINITIONS.map((d) => [d.key, d.default])));

/** Acepta coma decimal («1,5»). */
const num = (d) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? Number(v.trim().replace(',', '.')) : v),
    z
      .number({ error: 'Ingresá un número.' })
      .refine(Number.isFinite, 'Ingresá un número.')
      .min(d.min, `Mínimo ${d.min}${d.unit ? ` ${d.unit}` : ''}.`)
      .max(d.max, `Máximo ${d.max}${d.unit ? ` ${d.unit}` : ''}.`),
  );

function fieldSchema(d) {
  if (d.type === 'number') return num(d);
  if (d.type === 'enum') return z.enum(Object.keys(d.options), { error: 'Elegí una opción.' });
  return z
    .string()
    .trim()
    .min(3, 'Escribí al menos 3 caracteres.')
    .max(d.maxLength || 80, `Máximo ${d.maxLength || 80} caracteres.`);
}

const PAIRS = [
  ['corteModerado', 'corteAlto', 'El corte moderado debe ser menor que el corte alto.'],
  ['tempAmbienteMin', 'tempAmbienteMax', 'La temperatura mínima debe ser menor que la máxima.'],
  ['humedadMin', 'humedadMax', 'La humedad mínima debe ser menor que la máxima.'],
  ['rangoCamaraMin', 'rangoCamaraMax', 'El mínimo del rango debe ser menor que el máximo.'],
];

const settingsSchema = z
  .object(Object.fromEntries(DEFINITIONS.map((d) => [d.key, fieldSchema(d)])))
  .superRefine((v, ctx) => {
    for (const [lo, hi, message] of PAIRS) {
      if (Number.isFinite(v[lo]) && Number.isFinite(v[hi]) && v[lo] >= v[hi]) {
        ctx.addIssue({ code: 'custom', path: [hi], message });
      }
    }
  });

/** Completa con los valores por defecto (e ignora claves desconocidas). */
function withDefaults(values = {}) {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (values[k] !== undefined && values[k] !== null) out[k] = values[k];
  return out;
}

/**
 * Parámetros que se congelan en cada análisis. Las vistas de un estudio usan
 * SU snapshot, no la configuración vigente.
 */
function analysisParams(settings = DEFAULTS) {
  const s = withDefaults(settings);
  return {
    umbralPixel: s.umbralPixel,
    areaMinima: s.areaMinima,
    umbralCambio: s.umbralCambio,
    umbral: s.umbralAsimetria,
    corteSimetria: s.corteSimetria,
    referencia: s.referenciaBibliografica,
    cambioRelevante: s.cambioRelevante,
    corteModerado: s.corteModerado,
    corteAlto: s.corteAlto,
    horizonteSemanas: s.horizonteSemanas,
    protocolo: {
      tempAmbiente: { min: s.tempAmbienteMin, max: s.tempAmbienteMax },
      humedadRelativa: { min: s.humedadMin, max: s.humedadMax },
    },
  };
}

const DEFAULT_PARAMS = Object.freeze(analysisParams(DEFAULTS));

/** Rangos del protocolo en la forma que usan el modelo `Study` y el asistente. */
function protocolRanges(settings = DEFAULTS) {
  const s = withDefaults(settings);
  return {
    tempAmbiente: { min: s.tempAmbienteMin, max: s.tempAmbienteMax, unidad: '°C' },
    humedadRelativa: { min: s.humedadMin, max: s.humedadMax, unidad: '%' },
    distanciaCm: s.distanciaCm,
    emisividad: s.emisividad,
    rango: { min: s.rangoCamaraMin, max: s.rangoCamaraMax },
    tiempoEstabilizacionMin: s.estabilizacionMin,
  };
}

/** Texto de un valor con su unidad, para la auditoría. */
function describe(key, value) {
  const d = BY_KEY[key];
  if (!d) return String(value);
  if (d.type === 'enum') return d.options[value] || String(value);
  if (d.type === 'text') return `«${value}»`;
  const n = String(value).replace('.', ',');
  return d.unit ? `${n} ${d.unit}` : n;
}

module.exports = {
  GROUPS,
  DEFINITIONS,
  BY_KEY,
  DEFAULTS,
  DEFAULT_PARAMS,
  PALETAS,
  PALETA_CAMARA,
  settingsSchema,
  withDefaults,
  analysisParams,
  protocolRanges,
  describe,
};
