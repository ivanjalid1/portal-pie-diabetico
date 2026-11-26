'use strict';

/**
 * Carga LOCAL de los pacientes reales (SEED=real).
 *
 * Lee el resultado de `scripts/precompute-real.js` en `data-local/real/`
 * (carpeta ignorada por git y por Vercel): datos clínicos de la planilla,
 * identidad y las grillas punto a punto ya calculadas de cada toma. Las
 * imágenes se sirven desde el disco (montaje de sólo lectura en el
 * FileStorage), no se cargan en memoria.
 *
 * Si la carpeta no existe (CI, Vercel, pruebas) `loadRealDataset` devuelve
 * null y el contenedor usa la semilla de demostración.
 *
 * No se inventan datos clínicos: lo que falta en la planilla queda vacío.
 * Sólo se crean las cuentas del personal de demostración (para poder entrar)
 * y una cuenta de portal por paciente con un correo local derivado del código.
 */
const fs = require('node:fs');
const path = require('node:path');
const { STAFF, DEMO_PASSWORD } = require('./demoData');
const { CONSENT_VERSION, ACQUISITION } = require('../config/domain');
const { uuid } = require('../utils/random');
const { marcaSinConsentimiento } = require('../utils/consent');

const DAY = 86400000;
/** Intervalo típico entre tomas del estudio, para fechas de cámara no confiables. */
const DIAS_TIPICOS = 35;

function loadRealDataset(dir) {
  const file = path.join(dir || '', 'dataset.json');
  if (!dir || !fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.pacientes) ? data : null;
  } catch {
    return null;
  }
}

/** Fecha de la cámara (algunas tienen el reloj desconfigurado: año < 2020). */
const confiable = (iso) => Boolean(iso) && new Date(iso).getFullYear() >= 2020;

function fechasDe(p, t1, t2) {
  let f1 = confiable(t1.fecha) ? t1.fecha : null;
  if (!f1 && p.fechaToma1Planilla) f1 = new Date(`${p.fechaToma1Planilla}T12:00:00`).toISOString();
  let f2 = t2 ? (confiable(t2.fecha) ? t2.fecha : null) : null;
  const estimada = [];
  if (!f1 && f2) {
    f1 = new Date(new Date(f2).getTime() - DIAS_TIPICOS * DAY).toISOString();
    estimada.push(1);
  }
  if (t2 && !f2 && f1) {
    f2 = new Date(new Date(f1).getTime() + DIAS_TIPICOS * DAY).toISOString();
    estimada.push(2);
  }
  return { f1: f1 || new Date().toISOString(), f2, estimada };
}

function splitNombre(nombre) {
  const parts = String(nombre || '')
    .replace(/[.,]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return { nombre: '', apellido: '' };
  // La planilla registra «Apellido Nombre(s)».
  return { apellido: parts[0], nombre: parts.slice(1).join(' ') };
}

function clinicalFields(c, f1) {
  if (!c) return { tipoDm: null, sexo: null, fechaNacimiento: null, neuropatiaSinDato: true };
  const anio = new Date(f1).getFullYear();
  return {
    fechaNacimiento: c.edad ? `${anio - Math.round(c.edad)}-07-01` : null,
    sexo: c.sexo === 'F' || c.sexo === 'M' ? c.sexo : null,
    tipoDm: c.tipoDm,
    aniosEvolucionDm: c.aniosEvolucionDm,
    insulinorequiriente: Boolean(c.insulinorequiriente),
    hba1c: c.hba1c,
    hba1cNota: c.hba1c !== null ? 'Valor de la planilla clínica (sin fecha registrada).' : null,
    tabaquismo: c.tabaquismo,
    neuropatia: Boolean(c.neuropatia),
    neuropatiaSinDato: c.neuropatia === null || c.neuropatia === undefined,
    neuropatiaPuntaje: c.neuropatiaPuntaje,
    vibratoriaDer: c.vibratoriaDer,
    vibratoriaIzq: c.vibratoriaIzq,
    ulceraPreviaDer: Boolean(c.ulceraPreviaDer),
    ulceraPreviaIzq: Boolean(c.ulceraPreviaIzq),
    isquemia: Boolean(c.isquemia),
    ampollas: Boolean(c.ampollas),
    hiperqueratosis: Boolean(c.hiperqueratosis),
    eritema: Boolean(c.eritema),
    hematomas: Boolean(c.hematomas),
    generoLesion: c.generoLesion,
    observaciones: c.observaciones,
  };
}

/** El paciente no dio su consentimiento según la planilla (marca en cualquiera de sus textos). */
const sinConsentimiento = (p) =>
  Boolean(p.sinConsentimiento) ||
  [p.identidad?.nombre, p.clinica?.observaciones, ...(p.clinica?.textos || [])].some(marcaSinConsentimiento);

const imagen = (t, slot) => ({
  slot,
  storagePath: `real/${t.imagen}`,
  mime: 'image/png',
  size: 0,
  originalName: `${slot.toUpperCase()}.png`,
});

/** Correo de la cuenta de portal de un paciente real (driver memory). */
const correoLocal = (codigo) => `${codigo.replace('.', '').toLowerCase()}@pacientes.local`;

/** Imagen precalculada servida desde el montaje local `real/` (driver memory). */
const imagenLocal = async ({ toma, slot }) => imagen(toma, slot);

/**
 * Carga los pacientes reales usando sólo los contratos de repositorio: sirve
 * para el driver memory (arranque local con SEED=real) y para Supabase
 * (scripts/seed-supabase-real.js).
 *
 * @param {object} deps  `{ repos, predictor }` del driver activo
 * @param {object} options
 * @param {object}   options.dataset   resultado de scripts/precompute-real.js
 * @param {string}   [options.dir]     carpeta data-local/real (montaje de imágenes del driver memory)
 * @param {string}   [options.passwordHash] hash bcrypt de las cuentas (driver memory)
 * @param {object}   [options.staff]   cuentas del personal ya existentes `{ medico, ... }`;
 *   si falta se crean las de demostración (driver memory)
 * @param {(email: string, perfil: object) => Promise<string>} [options.createIdentity]
 *   crea la identidad de una cuenta y devuelve su id (por defecto: credencial local)
 * @param {{email?: (codigo: string) => string, activo?: boolean}} [options.patientAccount]
 *   correo y estado de la cuenta de portal de cada paciente
 * @param {(args: {patient, studyId, slot, toma, dir}) => Promise<object>} [options.saveImage]
 *   guarda la imagen de la toma y devuelve su registro (por defecto: montaje local)
 * @param {boolean} [options.skipExisting] idempotencia: no duplica pacientes, estudios ni análisis
 */
async function seedRealData(
  { repos, predictor },
  {
    dataset,
    dir,
    passwordHash,
    staff: existingStaff = null,
    createIdentity = null,
    patientAccount = {},
    saveImage = imagenLocal,
    skipExisting = false,
    log = () => {},
  },
) {
  if (dir && repos.files.mount) repos.files.mount('real/', dir);
  const identity = async (email, perfil) => {
    if (createIdentity) return createIdentity(email, perfil);
    const id = uuid();
    repos.credentials.set(id, passwordHash);
    return id;
  };
  const now = new Date();
  let staff = existingStaff;
  if (!staff) {
    staff = {};
    for (const s of STAFF) {
      const { key, ...profile } = s;
      staff[key] = await repos.users.create({
        ...profile,
        id: await identity(s.email, profile),
        activo: true,
        mustChangePassword: false,
        createdAt: new Date(now.getTime() - 200 * DAY).toISOString(),
      });
    }
  }
  const correo = patientAccount.email || correoLocal;
  const activo = patientAccount.activo !== false;
  // Todos los pacientes reales quedan a cargo de la cuenta médica principal.
  const medico = staff.medico;
  const resumen = {
    pacientes: 0,
    estudios: 0,
    sinToma2: 0,
    conZonasFaltantes: 0,
    excluidos: 0,
    existentes: 0,
    imagenes: 0,
  };

  for (const p of dataset.pacientes) {
    // Defensa en profundidad: aunque el precálculo ya los excluye, un paciente
    // sin consentimiento nunca se carga.
    if (sinConsentimiento(p)) {
      resumen.excluidos += 1;
      continue;
    }
    const t1 = p.tomas.find((t) => t.toma === 1 && t.ok);
    const t2 = p.tomas.find((t) => t.toma === 2 && t.ok) || null;
    const { f1, f2, estimada } = fechasDe(p, t1 || { fecha: null }, t2);
    const alta = new Date(new Date(f1).getTime() - 3600000).toISOString();

    let patient = skipExisting ? await repos.patients.findByCodigo(p.codigo) : null;
    if (patient) {
      resumen.existentes += 1;
    } else {
      const { nombre, apellido } = splitNombre(p.identidad?.nombre);
      const email = correo(p.codigo);
      const perfil = {
        email,
        role: 'paciente',
        nombre: nombre || p.codigo,
        apellido,
        telefono: p.identidad?.telefono || null,
        institucion: p.centro,
        activo,
        mustChangePassword: false,
        createdAt: alta,
      };
      const user =
        (skipExisting && (await repos.users.findByEmail(email))) ||
        (await repos.users.create({ ...perfil, id: await identity(email, perfil) }));
      patient = await repos.patients.create({
        ...clinicalFields(p.clinica, f1),
        codigo: p.codigo,
        dni: p.identidad?.dni || null,
        centro: p.centro,
        userId: user.id,
        medicoId: medico.id,
        consentimientoFirmado: true,
        consentimientoFecha: f1.slice(0, 10),
        createdAt: alta,
      });
      await repos.consents.create({
        patientId: patient.id,
        version: CONSENT_VERSION,
        fechaFirma: f1.slice(0, 10),
        registradoPor: medico.id,
        notas: 'Participante del estudio (planilla clínica del equipo).',
        createdAt: alta,
      });
    }
    resumen.pacientes += 1;
    if (!t1) continue;

    // Un estudio por paciente real; si ya está cargado sólo se completa el análisis.
    let study = skipExisting ? (await repos.studies.listByPatient(patient.id))[0] || null : null;
    const fecha = t2 ? f2 : f1;
    if (!study) {
      const noValido = Boolean(p.clinica?.noValido);
      const studyId = uuid();
      const images = [];
      for (const [toma, slot] of [[t1, 'toma1'], ...(t2 ? [[t2, 'toma2']] : [])]) {
        images.push(await saveImage({ patient, studyId, slot, toma, dir }));
        resumen.imagenes += 1;
      }
      study = await repos.studies.create({
        id: studyId,
        patientId: patient.id,
        medicoId: medico.id,
        fechaHora: fecha,
        fechaToma1: f1,
        centro: p.centro,
        distanciaCm: ACQUISITION.distanciaCm,
        emisividad: ACQUISITION.emisividad,
        rangoMin: ACQUISITION.rango.min,
        rangoMax: ACQUISITION.rango.max,
        paleta: 'High Contrast',
        valida: !noValido,
        motivoInvalidez: noValido
          ? 'Marcado en la planilla clínica como «no válido» por la imagen (excluido en la Parte 1).'
          : null,
        images,
        estado: 'analizado',
        notasMedico: estimada.length
          ? `Fecha de la toma ${estimada.join(' y ')} estimada: el reloj de la cámara no estaba configurado.`
          : '',
        publicado: true,
        publicadoAt: fecha,
        createdAt: fecha,
      });
    }
    let analysis = skipExisting ? await repos.analyses.findByStudyId(study.id) : null;
    if (!analysis) {
      const output = await predictor.predict({
        patient,
        study,
        images: [],
        hints: { puntual: { toma1: { ...t1, fecha: f1 }, ...(t2 ? { toma2: { ...t2, fecha: f2 } } : {}) } },
      });
      analysis = await repos.analyses.create({ ...output, studyId: study.id, createdAt: fecha });
    }
    resumen.estudios += 1;
    if (!t2) resumen.sinToma2 += 1;
    if (analysis.puntual?.tomas?.some((t) => t.zonasNoAnalizadas?.length)) resumen.conZonasFaltantes += 1;
  }
  log(
    `datos reales: ${resumen.pacientes} pacientes, ${resumen.estudios} estudios, ${resumen.sinToma2} sin toma 2, ${resumen.conZonasFaltantes} con zonas no analizadas, ${resumen.excluidos} excluidos sin consentimiento`,
  );
  return { staff, resumen };
}

module.exports = { loadRealDataset, seedRealData, sinConsentimiento, correoLocal, DEMO_PASSWORD };
