'use strict';

const { z } = require('zod');
const f = require('./fields');
const {
  ACQUISITION,
  ROIS,
  EXCLUSION_CRITERIA,
  CAPTURE_CHECKLIST,
  CENTRO_NOMBRES,
  CODIGO_REGEX,
  VIBRATORIA_MAX,
} = require('../config/domain');

/* ---------- Autenticación ---------- */

const loginSchema = z.object({
  email: f.email(),
  password: z.string().min(1, 'Ingresá tu contraseña.').max(200),
  next: z.string().optional(),
});

const PASSWORD_RULES = 'Usá al menos 8 caracteres, con mayúscula, minúscula y número.';
const strongPassword = z
  .string()
  .min(8, PASSWORD_RULES)
  .max(100)
  .regex(/[a-z]/, PASSWORD_RULES)
  .regex(/[A-Z]/, PASSWORD_RULES)
  .regex(/\d/, PASSWORD_RULES);

const changePasswordSchema = z
  .object({
    actual: z.string().min(1, 'Ingresá tu contraseña actual.'),
    nueva: strongPassword,
    confirmacion: z.string(),
  })
  .refine((d) => d.nueva === d.confirmacion, { path: ['confirmacion'], message: 'Las contraseñas no coinciden.' });

/* ---------- Administración ---------- */

const medicoSchema = z.object({
  nombre: f.text('Nombre', { max: 80 }),
  apellido: f.text('Apellido', { max: 80 }),
  email: f.email(),
  matricula: f.text('Matrícula', { max: 30 }),
  especialidad: f.optionalText(80),
  institucion: f.text('Institución', { max: 120 }),
});

/* ---------- Pacientes ---------- */

const exclusionShape = Object.fromEntries(EXCLUSION_CRITERIA.map((c) => [c.key, f.checkbox()]));

const patientBase = z.object({
  nombre: f.text('Nombre', { max: 80 }),
  apellido: f.text('Apellido', { max: 80 }),
  codigo: z.preprocess(
    (v) => (f.empty(v) ? null : String(v).trim().toUpperCase()),
    z.union([z.null(), z.string().regex(CODIGO_REGEX, 'Formato de código esperado: DEMO-002, DEMO-005 o DEMO-011.')]),
  ),
  dni: z.preprocess(
    (v) => (f.empty(v) ? null : String(v).replace(/[.\s-]/g, '')),
    z.union([z.null(), z.string().regex(/^\d{7,8}$/, 'El DNI debe tener 7 u 8 dígitos.')]),
  ),
  fechaNacimiento: f.date('Fecha de nacimiento', { notFuture: true }).refine((v) => {
    const age = (Date.now() - new Date(v).getTime()) / (365.25 * 86400000);
    return age >= 18 && age <= 110;
  }, 'El protocolo incluye sólo pacientes adultos (18 años o más).'),
  sexo: z.enum(['F', 'M'], { error: 'Seleccioná el sexo.' }),
  email: f.email(),
  telefono: f.optionalText(30),
  centro: z.enum([...CENTRO_NOMBRES], { error: 'Seleccioná el centro.' }),
  tipoDm: z.enum(['I', 'II'], { error: 'Seleccioná el tipo de diabetes.' }),
  aniosEvolucionDm: f.number('Años de evolución', { min: 0, max: 80 }),
  insulinorequiriente: f.checkbox(),
  hba1c: f.optionalNumber('HbA1c', { min: 3, max: 20 }),
  hba1cFecha: f.optionalDate('Fecha de HbA1c', { notFuture: true }),
  hba1cImputada: f.checkbox(),
  hba1cNota: f.optionalText(300),
  tabaquismo: z.preprocess((v) => (v === 'si' ? true : v === 'no' ? false : null), z.union([z.boolean(), z.null()])),
  neuropatia: f.checkbox(),
  neuropatiaPuntaje: f.optionalNumber('Puntaje de neuropatía', { min: 0, max: 10, int: true }),
  vibratoriaDer: f.optionalNumber('Percepción vibratoria derecha', { min: 0, max: VIBRATORIA_MAX }),
  vibratoriaDerMas50: f.checkbox(),
  vibratoriaIzq: f.optionalNumber('Percepción vibratoria izquierda', { min: 0, max: VIBRATORIA_MAX }),
  vibratoriaIzqMas50: f.checkbox(),
  ulceraPreviaDer: f.checkbox(),
  ulceraPreviaIzq: f.checkbox(),
  isquemia: f.checkbox(),
  ampollas: f.checkbox(),
  hiperqueratosis: f.checkbox(),
  hiperqueratosisLocalizacion: f.optionalText(200),
  eritema: f.checkbox(),
  hematomas: f.checkbox(),
  indiceTobilloBrazo: f.optionalNumber('Índice tobillo-brazo', { min: 0.2, max: 2 }),
  pesoKg: f.optionalNumber('Peso', { min: 30, max: 250 }),
  cirugiasPrevias: f.optionalText(500),
  patologiasPrevias: f.optionalText(500),
  observaciones: f.optionalText(1000),
  exclusion: z.preprocess((v) => v || {}, z.object(exclusionShape)),
  consentimientoFirmado: f.checkbox(),
  consentimientoFecha: f.optionalDate('Fecha del consentimiento', { notFuture: true }),
});

function clinicalRefinements(d, ctx) {
  if (d.hba1c !== null && d.hba1c !== undefined) d.hba1c = Math.round(d.hba1c * 10) / 10;
  if (d.neuropatia && (d.neuropatiaPuntaje === null || d.neuropatiaPuntaje === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['neuropatiaPuntaje'], message: 'Indicá el puntaje de neuropatía (0–10).' });
  }
  if (!d.neuropatia) d.neuropatiaPuntaje = 0;
  if (d.vibratoriaDerMas50) d.vibratoriaDer = null;
  if (d.vibratoriaIzqMas50) d.vibratoriaIzq = null;
  if (!d.hiperqueratosis) d.hiperqueratosisLocalizacion = null;
  if (d.consentimientoFirmado && !d.consentimientoFecha) {
    ctx.addIssue({
      code: 'custom',
      path: ['consentimientoFecha'],
      message: 'Indicá la fecha de firma del consentimiento.',
    });
  }
}

const patientCreateSchema = patientBase.superRefine(clinicalRefinements);
const patientUpdateSchema = patientBase
  .omit({ email: true, codigo: true, exclusion: true, consentimientoFirmado: true, consentimientoFecha: true })
  .superRefine(clinicalRefinements);

/* ---------- Estudios ---------- */

const ROI_KEYS = ROIS.map((r) => r.key);
const CHECK_KEYS = CAPTURE_CHECKLIST.map((c) => c.key);

/** "2026-11-12T10:30" (hora local de Córdoba, UTC−3) → ISO. */
function localToIso(v) {
  if (f.empty(v)) return new Date().toISOString();
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? new Date(`${s}:00-03:00`) : new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

const studySchema = z
  .object({
    patientId: z.string().uuid('Seleccioná un paciente.'),
    toma1Origen: z.preprocess(
      (v) => (f.empty(v) || v === 'nueva' ? null : v),
      z.union([z.null(), z.string().uuid('Estudio de origen inválido.')]),
    ),
    fechaToma1: f.optionalDate('Fecha de la toma 1', { notFuture: true }),
    tempAmbienteToma1: f.optionalNumber('Temperatura ambiente de la toma 1', { min: 10, max: 40 }),
    humedadRelativaToma1: f.optionalNumber('Humedad relativa de la toma 1', { min: 0, max: 100 }),
    fechaHora: z.preprocess(
      localToIso,
      z
        .string()
        .refine((v) => !Number.isNaN(new Date(v).getTime()), 'Fecha y hora inválidas.')
        .refine((v) => new Date(v).getTime() <= Date.now() + 5 * 60000, 'La fecha de la toma 2 no puede ser futura.'),
    ),
    centro: z.enum([...CENTRO_NOMBRES], { error: 'Seleccioná el centro.' }),
    tempAmbiente: f.number('Temperatura ambiente', { min: 10, max: 40 }),
    humedadRelativa: f.number('Humedad relativa', { min: 0, max: 100 }),
    distanciaCm: f.number('Distancia', { min: 30, max: 300 }),
    emisividad: f.number('Emisividad', { min: 0.9, max: 1 }),
    rangoMin: f.number('Rango mínimo', { min: 0, max: 40 }),
    rangoMax: f.number('Rango máximo', { min: 10, max: 50 }),
    paleta: z.enum([...ACQUISITION.paletas], { error: 'Seleccioná una paleta.' }),
    tiempoEstabilizacionMin: f.number('Tiempo de estabilización', { min: 0, max: 120, int: true }),
    fondo: z.enum([...ACQUISITION.fondos], { error: 'Seleccioná el fondo.' }),
    valida: z.enum(['si', 'no'], { error: 'Indicá si la imagen es válida.' }).transform((v) => v === 'si'),
    motivoInvalidez: f.optionalText(300),
    checklist: f.list().pipe(z.array(z.enum(CHECK_KEYS))),
    consentimientoVerificado: f.checkbox(),
  })
  .superRefine((d, ctx) => {
    if (d.rangoMin >= d.rangoMax) {
      ctx.addIssue({ code: 'custom', path: ['rangoMax'], message: 'El máximo del rango debe superar al mínimo.' });
    }
    if (!d.valida && !d.motivoInvalidez) {
      ctx.addIssue({
        code: 'custom',
        path: ['motivoInvalidez'],
        message: 'Indicá el motivo por el que la imagen no es válida.',
      });
    }
    if (!d.toma1Origen && !d.fechaToma1) {
      ctx.addIssue({ code: 'custom', path: ['fechaToma1'], message: 'Indicá la fecha de la toma 1.' });
    }
    if (d.fechaToma1 && new Date(`${d.fechaToma1}T12:00:00-03:00`) >= new Date(d.fechaHora)) {
      ctx.addIssue({ code: 'custom', path: ['fechaToma1'], message: 'La toma 1 debe ser anterior a la toma 2.' });
    }
    if (!d.consentimientoVerificado) {
      ctx.addIssue({
        code: 'custom',
        path: ['consentimientoVerificado'],
        message: 'Confirmá que verificaste el consentimiento informado.',
      });
    }
  });

const notesSchema = z.object({ notasMedico: z.string().trim().max(4000, 'Máximo 4000 caracteres.').default('') });

const publishSchema = z.object({ publicado: f.checkbox() });

const outcomeSchema = z
  .object({
    generoLesion: z.enum(['si', 'no'], { error: 'Indicá si generó lesión.' }).transform((v) => v === 'si'),
    pie: z.preprocess((v) => (f.empty(v) ? null : v), z.union([z.null(), z.enum(['derecho', 'izquierdo', 'ambos'])])),
    roi: z.preprocess((v) => (f.empty(v) ? null : v), z.union([z.null(), z.enum(ROI_KEYS)])),
    fecha: f.date('Fecha del desenlace', { notFuture: true }),
    notas: z.string().trim().max(1000).default(''),
  })
  .superRefine((d, ctx) => {
    if (d.generoLesion && !d.pie)
      ctx.addIssue({ code: 'custom', path: ['pie'], message: 'Indicá en qué pie apareció la lesión.' });
    if (d.generoLesion && !d.roi)
      ctx.addIssue({ code: 'custom', path: ['roi'], message: 'Indicá la región de la lesión.' });
    if (!d.generoLesion) {
      d.pie = null;
      d.roi = null;
    }
  });

const consentSchema = z.object({
  fechaFirma: f.date('Fecha de firma', { notFuture: true }),
  notas: f.optionalText(500),
  confirmo: f.checkbox().refine((v) => v, 'Confirmá que el paciente firmó el documento vigente.'),
});

const revokeConsentSchema = z.object({
  motivo: f.text('Motivo', { min: 3, max: 300 }),
});

const appointmentSchema = z.object({
  fecha: f.date('Fecha del control'),
  motivo: z.string().trim().max(200).default('Control termográfico a 6 semanas'),
});

const appointmentStatusSchema = z
  .object({
    estado: z.enum(['realizado', 'ausente', 'cancelado'], { error: 'Estado inválido.' }),
    motivo: f.optionalText(300),
    volver: z.string().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.estado === 'ausente' && !d.motivo) {
      ctx.addIssue({ code: 'custom', path: ['motivo'], message: 'Indicá el motivo de la ausencia.' });
    }
  });

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const controlesFilterSchema = z.object({
  vista: z.enum(['proximos', 'vencidos', 'realizados']).catch('proximos'),
  desde: z.preprocess((v) => (f.empty(v) ? undefined : v), z.string().regex(ISO_DAY).optional()).catch(undefined),
  hasta: z.preprocess((v) => (f.empty(v) ? undefined : v), z.string().regex(ISO_DAY).optional()).catch(undefined),
  riesgo: z.enum(['sin_riesgo', 'moderado', 'alto']).optional().catch(undefined),
});

module.exports = {
  loginSchema,
  changePasswordSchema,
  medicoSchema,
  patientCreateSchema,
  patientUpdateSchema,
  studySchema,
  notesSchema,
  publishSchema,
  outcomeSchema,
  consentSchema,
  revokeConsentSchema,
  appointmentSchema,
  appointmentStatusSchema,
  controlesFilterSchema,
  localToIso,
};
