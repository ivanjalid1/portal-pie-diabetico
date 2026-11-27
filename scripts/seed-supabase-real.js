#!/usr/bin/env node
'use strict';

/**
 * Carga los pacientes REALES (data-local/real/, resultado de
 * scripts/precompute-real.js) en Supabase: fichas, estudios, análisis punto a
 * punto (U-Net precalculada, TCI, riesgo, alertas) y las imágenes de cada toma
 * en el bucket privado `estudios`. Usa la misma carga que el driver memory con
 * SEED=real (src/seed/realData.js) sobre los repositorios de Supabase.
 *
 * Los datos reales nunca pasan por git ni por Vercel: se leen del disco local
 * y van sólo a Postgres y a Storage privado.
 *
 * - Idempotente: no duplica pacientes (por código), estudios ni análisis.
 * - Los pacientes NO tienen acceso al portal: su perfil (necesario para el
 *   nombre y el teléfono que ve el equipo) usa un correo no entregable, una
 *   contraseña aleatoria que no se guarda, la cuenta de Auth bloqueada y el
 *   perfil desactivado.
 * - Excluye a los pacientes sin consentimiento (src/utils/consent.js).
 *
 * Uso:
 *   node scripts/seed-supabase-real.js --dry-run         (no escribe nada)
 *   node scripts/seed-supabase-real.js
 *   node scripts/seed-supabase-real.js --purge-demo      (antes borra pacientes y cuentas demo)
 *   node scripts/seed-supabase-real.js --rotate-staff=<archivo>
 *        (contraseñas nuevas para medico@ y admin@; se escriben SÓLO en <archivo>)
 *   node scripts/seed-supabase-real.js --models          (sube los modelos de data-local al bucket `modelos`)
 *   node scripts/seed-supabase-real.js --ambiente        (estudios ya cargados: completa el ambiente de
 *        cada toma —data-local/real/ambiente.json— y recalcula su análisis con la configuración vigente)
 *   node scripts/seed-supabase-real.js --actualizar      (estudios ya cargados: una foto por toma —la
 *        elegida en «Revisión de fotos» o la sugerida—, sube la imagen y los datos de análisis de CADA
 *        réplica al almacenamiento privado —para cambiar la foto desde el portal—, recalcula el análisis
 *        con la configuración vigente y quita la marca automática «no válido» de la Parte 1. Después de
 *        cargar pacientes nuevos, correr también --actualizar)
 */
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

/** Dominio reservado (RFC 2606): ningún correo de paciente es entregable. */
const PATIENT_EMAIL_DOMAIN = 'sin-acceso.invalid';
const patientEmail = (codigo) => `${String(codigo).replace('.', '').toLowerCase()}@${PATIENT_EMAIL_DOMAIN}`;
/** Bloqueo de la identidad de Auth de los pacientes (~100 años). */
const BAN_DURATION = '876000h';
const STAFF_KEYS = Object.freeze({ medico: 'medico@demo.com', admin: 'admin@demo.com' });

/** Contraseña aleatoria con mayúsculas, minúsculas, dígitos y símbolos. */
function generatePassword(length = 20) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#%+-.=?@_'];
  const all = sets.join('');
  const chars = sets.map((s) => s[crypto.randomInt(s.length)]);
  while (chars.length < length) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function parseArgs(argv) {
  const get = (name) => {
    const a = argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
    if (!a) return undefined;
    return a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
  };
  return {
    dryRun: Boolean(get('dry-run')),
    purgeDemo: Boolean(get('purge-demo')),
    rotateStaff: typeof get('rotate-staff') === 'string' ? get('rotate-staff') : null,
    models: Boolean(get('models')),
    skipPatients: Boolean(get('skip-patients')),
    ambiente: Boolean(get('ambiente')),
    actualizar: Boolean(get('actualizar')),
  };
}

/** Archivos de modelos locales que se suben al bucket `modelos`. */
function localModelFiles(localDataDir) {
  const { REMOTE_MODELS } = require('../src/config/remoteModels');
  return REMOTE_MODELS.map((m) => ({ ...m, path: path.join(localDataDir, ...m.local) })).filter((m) =>
    fs.existsSync(m.path),
  );
}

async function listAuthUsers(admin) {
  const out = new Map();
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    for (const u of data.users) out.set(String(u.email).toLowerCase(), u);
    if (data.users.length < 200) break;
  }
  return out;
}

async function removeFolder(admin, bucket, prefix) {
  const { data } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
  for (const o of data || []) {
    const p = `${prefix}/${o.name}`;
    if (o.id === null) await removeFolder(admin, bucket, p);
    else await admin.storage.from(bucket).remove([p]);
  }
}

/** Borra los pacientes DEMO-xxx, sus imágenes y las cuentas demo de pacientes y de medico2. */
async function purgeDemo(admin, config, log) {
  const { STAFF, PATIENTS } = require('../src/seed/demoData');
  const { data: pats, error } = await admin.from('patients').select('id, codigo').like('codigo', 'DEMO-%');
  if (error) throw error;
  const ids = pats.map((p) => p.id);
  if (ids.length) {
    for (const id of ids) await removeFolder(admin, config.supabase.bucket, id);
    await admin.from('appointments').delete().in('patient_id', ids);
    await admin.from('studies').delete().in('patient_id', ids);
    const { error: e2 } = await admin.from('patients').delete().in('id', ids);
    if (e2) throw e2;
  }
  await admin.from('audit_log').delete().ilike('detail', '%DEMO-%');
  const demoEmails = new Set([
    ...PATIENTS.map((p) => p.personal.email.toLowerCase()),
    ...STAFF.filter((s) => !Object.values(STAFF_KEYS).includes(s.email)).map((s) => s.email),
  ]);
  const users = await listAuthUsers(admin);
  let cuentas = 0;
  for (const [email, u] of users) {
    if (!demoEmails.has(email)) continue;
    const { error: e3 } = await admin.auth.admin.deleteUser(u.id);
    if (e3) throw new Error(`no se pudo borrar una cuenta demo: ${e3.message}`);
    cuentas += 1;
  }
  log(`demo eliminada: ${ids.length} pacientes, ${cuentas} cuentas`);
}

/** Contraseñas nuevas del personal; se escriben sólo en `file` (nunca en la salida). */
async function rotateStaff(admin, file) {
  const users = await listAuthUsers(admin);
  const lines = [
    '# Credenciales PRIVADAS de producción (no versionar, no compartir por chat).',
    `# Generado: ${new Date().toISOString()}`,
    'URL=https://portal-pie-diabetico.vercel.app',
  ];
  for (const [key, email] of Object.entries(STAFF_KEYS)) {
    const u = users.get(email);
    if (!u) throw new Error(`no existe la cuenta ${email}`);
    const password = generatePassword(20);
    const { error } = await admin.auth.admin.updateUserById(u.id, { password, ban_duration: 'none' });
    if (error) throw new Error(`no se pudo cambiar la contraseña de ${email}: ${error.message}`);
    lines.push(`${key.toUpperCase()}_EMAIL=${email}`, `${key.toUpperCase()}_PASSWORD=${password}`);
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
}

async function uploadModels(admin, localDataDir, log, dryRun) {
  const { MODELS_BUCKET } = require('../src/config/remoteModels');
  let total = 0;
  for (const m of localModelFiles(localDataDir)) {
    const buffer = fs.readFileSync(m.path);
    total += buffer.length;
    if (!dryRun) {
      const { error } = await admin.storage
        .from(MODELS_BUCKET)
        .upload(m.file, buffer, { contentType: 'application/json', upsert: true });
      if (error) throw new Error(`storage.upload ${m.file}: ${error.message}`);
    }
    log(`modelo ${m.file} (${(buffer.length / 1024).toFixed(0)} KB)`);
  }
  return total;
}

/**
 * Estudios reales ya cargados: guarda el ambiente MEDIDO en el estudio y
 * recalcula el análisis con el ambiente de cada toma (medido o estimado), con
 * la configuración vigente. Sólo cambian las temperaturas absolutas ajustadas y
 * el TCI ajustado: ΔT, área caliente, alertas y pronóstico no dependen del ambiente.
 */
async function updateAmbient({ repos, predictor, dataset, dryRun, log }) {
  const { camposAmbiente } = require('../src/seed/realData');
  const SettingsService = require('../src/services/SettingsService');
  const settings = new SettingsService({ settings: repos.settings, analyses: repos.analyses, events: null });
  const params = await settings.params();
  const tot = { estudios: 0, sinCambios: 0, cambiaronCategoria: 0, faltan: 0 };
  for (const p of dataset.pacientes) {
    const patient = await repos.patients.findByCodigo(p.codigo);
    const study = patient ? (await repos.studies.listByPatient(patient.id))[0] : null;
    const a = study ? await repos.analyses.findByStudyId(study.id) : null;
    if (!a?.puntual) {
      tot.faltan += 1;
      continue;
    }
    const amb = dataset.ambiente?.[p.codigo] || {};
    const campos = camposAmbiente(amb, Boolean(study.image('toma2')));
    const hints = {
      puntual: Object.fromEntries(
        a.puntual.tomas.map((t) => [`toma${t.toma}`, { ...t, ambiente: amb[t.toma] || null }]),
      ),
    };
    const out = await predictor.predict({ patient, study: { ...study, ...campos }, hints, params });
    const { rois: _r, roisToma1: _r1, ...fields } = out;
    if (fields.categoria !== a.categoria) tot.cambiaronCategoria += 1;
    if (!dryRun) {
      await repos.studies.update(study.id, campos);
      await repos.analyses.update(a.id, fields);
    }
    tot.estudios += 1;
  }
  log(`ambiente: ${JSON.stringify(tot)}`);
}

/** Motivo que la carga anterior ponía a los marcados «NO VALIDO» (ahora sólo etiqueta histórica). */
const MOTIVO_NO_VALIDO_ANTERIOR =
  'Marcado en la planilla clínica como «no válido» por la imagen (excluido en la Parte 1).';

/**
 * Datos de análisis de cada réplica de las tomas de un paciente para el
 * almacenamiento privado (ReplicaStore): el TCI de cada réplica ya trae el
 * ajuste por el ambiente de la toma, porque en producción no está la
 * referencia del TCI para recalcularlo.
 */
function replicasDePaciente(p, amb, tciReference) {
  const { analyzePointwise } = require('../src/services/predictors/pointwiseAnalysis');
  const out = {};
  for (const t of p.tomas) {
    if (!t.ok || !Array.isArray(t.porReplica) || !t.porReplica.length) continue;
    out[t.toma] = t.porReplica.map((r) => {
      if (!tciReference) return r;
      const [x] = analyzePointwise({ toma1: { ...r, ambiente: amb[t.toma] || null } }, {}, { tciReference }).tomas;
      return { ...r, tci: x?.tci ?? r.tci ?? null };
    });
  }
  return out;
}

/**
 * Estudios reales ya cargados: grillas del dataset (una foto por toma: la
 * elegida en «Revisión de fotos» o la sugerida), los datos de cada réplica en
 * el almacenamiento privado (para poder cambiar la foto desde el portal), la
 * imagen PNG de cada réplica, el análisis recalculado con la configuración
 * vigente y sin la marca automática «no válido» de la Parte 1. No toca las
 * fichas, los consentimientos, las revisiones ni lo que haya marcado a mano el
 * equipo (otro motivo de invalidez se respeta).
 */
async function refreshExisting({ repos, admin, bucket, predictor, dataset, dir, dryRun, log }) {
  const { camposAmbiente, sinConsentimiento } = require('../src/seed/realData');
  const SettingsService = require('../src/services/SettingsService');
  const { ReplicaStore, REMOTE_REPLICAS } = require('../src/services/ReplicaStore');
  const { tomaConReplica } = require('../src/imaging/replicaChoice');
  const { loadReferenceStore, referenceFor } = require('../src/services/predictors/tciReference');
  const settings = new SettingsService({ settings: repos.settings, analyses: repos.analyses, events: null });
  const params = await settings.params();
  const tciStore = loadReferenceStore(dir);
  const tot = {
    estudios: 0,
    imagenes: 0,
    replicas: 0,
    cambiaronCategoria: 0,
    validados: 0,
    faltan: 0,
    nuevos: 0,
    elegidasAMano: 0,
    contornosCorregidos: 0,
  };
  const cambios = [];
  const upload = async (key, buffer, contentType) => {
    if (dryRun) return;
    const { error } = await admin.storage.from(bucket).upload(key, buffer, { contentType, upsert: true });
    if (error) throw new Error(`storage.upload: ${error.message}`);
  };
  for (const p of dataset.pacientes) {
    if (sinConsentimiento(p)) continue;
    const t1 = p.tomas.find((t) => t.toma === 1 && t.ok);
    const t2 = p.tomas.find((t) => t.toma === 2 && t.ok) || null;
    if (!t1) continue;
    const patient = await repos.patients.findByCodigo(p.codigo);
    if (!patient) {
      tot.nuevos += 1;
      continue;
    }
    const study = (await repos.studies.listByPatient(patient.id))[0] || null;
    const a = study ? await repos.analyses.findByStudyId(study.id) : null;
    if (!study || !a) {
      tot.faltan += 1;
      continue;
    }
    const amb = dataset.ambiente?.[p.codigo] || {};
    const conT2 = Boolean(t2 && study.image('toma2'));
    const campos = camposAmbiente(amb, conT2);
    const porToma = replicasDePaciente(p, amb, referenceFor(tciStore, p.codigo));
    // Foto elegida a mano en «Revisión de fotos» (si la hay); si no, la sugerida.
    const reviews = repos.tomaReviews ? await repos.tomaReviews.listByStudy(study.id) : [];
    const usadas = {};
    // Contornos corregidos a mano (MaskCorrectionService): se usan sus grillas en la foto usada.
    const corregidos = repos.maskCorrections ? await repos.maskCorrections.listByStudy(study.id) : [];
    const conContorno = async (toma, entry) => {
      const row = corregidos.find((c) => c.toma === toma && c.replica === entry.rep);
      if (!row?.storagePath || !repos.files) return entry;
      try {
        const f = JSON.parse(zlib.gunzipSync(await repos.files.read(row.storagePath)).toString('utf8'));
        const quien = row.corregidoPor ? await repos.users.findById(row.corregidoPor) : null;
        tot.contornosCorregidos += 1;
        return {
          ...entry,
          izq: f.izq,
          der: f.der,
          calidad: f.calidad ?? entry.calidad,
          marco: f.marco ?? entry.marco,
          segmentacion: 'manual',
          tci: null,
          contorno: { por: quien?.nombreCompleto || 'un usuario' },
        };
      } catch {
        return entry;
      }
    };
    const tomaHint = async (t, fecha) => {
      const base = { ...t, fecha, ambiente: amb[t.toma] || null };
      const reps = porToma[t.toma] || [];
      const rv = reviews.find((r) => r.toma === t.toma && r.replicaElegida);
      const elegida = rv ? reps.find((r) => r.rep === rv.replicaElegida) : null;
      const entry = elegida || reps.find((r) => r.rep === t.replica) || null;
      usadas[t.toma] = entry ? entry.rep : t.replica;
      if (!entry) return base;
      if (elegida) tot.elegidasAMano += 1;
      const quien = elegida && rv.revisadoPor ? await repos.users.findById(rv.revisadoPor) : null;
      const revisor = elegida ? quien?.nombreCompleto || 'un usuario' : null;
      const final = await conContorno(t.toma, entry);
      if (!elegida && final === entry) return base;
      return { ...tomaConReplica(base, final, { revisor }), fecha, ambiente: base.ambiente };
    };
    const hints = {
      puntual: {
        toma1: await tomaHint(t1, study.fechaToma1 || study.fechaHora),
        ...(conT2 ? { toma2: await tomaHint(t2, study.fechaHora) } : {}),
      },
    };
    const out = await predictor.predict({ patient, study: { ...study, ...campos }, hints, params });
    if (out.categoria !== a.categoria) {
      tot.cambiaronCategoria += 1;
      cambios.push(`${p.codigo} ${a.categoria}→${out.categoria}`);
    }
    const validar = !study.valida && study.motivoInvalidez === MOTIVO_NO_VALIDO_ANTERIOR;
    if (validar) tot.validados += 1;
    // Imagen PNG y datos de análisis de cada réplica (almacenamiento privado).
    for (const [t, slot] of [[t1, 'toma1'], ...(conT2 ? [[t2, 'toma2']] : [])]) {
      if (!study.image(slot)) continue;
      for (const r of porToma[t.toma] || []) {
        if (!r.imagen) continue;
        await upload(
          REMOTE_REPLICAS.image(study, t.toma, r.rep),
          fs.readFileSync(path.join(dir, r.imagen)),
          'image/png',
        );
        tot.imagenes += 1;
      }
      if (!dryRun && (porToma[t.toma] || []).length) {
        await repos.studies.updateImage(study.id, slot, {
          storagePath: REMOTE_REPLICAS.image(study, t.toma, usadas[t.toma]),
        });
      }
      tot.replicas += (porToma[t.toma] || []).length;
    }
    const tomasRemotas = Object.fromEntries(Object.entries(porToma).filter(([k]) => Number(k) === 1 || conT2));
    if (Object.keys(tomasRemotas).length) {
      await upload(REMOTE_REPLICAS.file(study), ReplicaStore.remoteFile(tomasRemotas), 'application/octet-stream');
    }
    if (!dryRun) {
      await repos.studies.update(study.id, { ...campos, ...(validar ? { valida: true, motivoInvalidez: null } : {}) });
      await repos.analyses.update(a.id, out);
    }
    tot.estudios += 1;
  }
  log(`actualizar: ${JSON.stringify(tot)}`);
  if (cambios.length) log(`categoría: ${cambios.join(', ')}`);
  return tot;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { buildConfig } = require('../src/config');
  const { createDataLayer } = require('../src/repositories/RepositoryFactory');
  const { createPredictor } = require('../src/services/predictors/PredictorFactory');
  const { loadRealDataset, seedRealData } = require('../src/seed/realData');
  const { getSupabaseClients } = require('../src/config/supabase');

  const config = buildConfig({ ...process.env, DATA_DRIVER: 'supabase', SEED: 'real' });
  const log = (m) => console.log(`  ${m}`);
  const dataset = loadRealDataset(config.realDataDir);
  if (!dataset) throw new Error(`no se encontró ${config.realDataDir}/dataset.json`);
  const { admin } = getSupabaseClients(config);
  console.log(`${args.dryRun ? '[dry-run] ' : ''}Supabase: ${config.supabase.url}`);

  if (args.models) {
    const bytes = await uploadModels(admin, config.localDataDir, log, args.dryRun);
    log(`modelos: ${(bytes / 1048576).toFixed(2)} MB`);
  }
  if (args.purgeDemo && !args.dryRun) await purgeDemo(admin, config, log);
  if (args.rotateStaff && !args.dryRun) {
    await rotateStaff(admin, path.resolve(args.rotateStaff));
    log(`contraseñas del personal renovadas (ver ${path.resolve(args.rotateStaff)})`);
  }
  if (args.skipPatients) return;

  if (args.ambiente) {
    const predictorA = createPredictor(config.predictor, {
      realDataDir: config.realDataDir,
      riesgoModelo: config.riesgoModelo,
    });
    await updateAmbient({
      repos: createDataLayer(config).repos,
      predictor: predictorA,
      dataset,
      dryRun: args.dryRun,
      log,
    });
    return;
  }

  // Mismo predictor que la carga local SEED=real (referencia del TCI y modelos de data-local).
  const predictor = createPredictor(config.predictor, {
    realDataDir: config.realDataDir,
    riesgoModelo: config.riesgoModelo,
  });
  log(`predictor: ${predictor.info.version}`);

  if (args.actualizar) {
    // Lecturas reales también en --dry-run (sólo se omiten las escrituras).
    await refreshExisting({
      repos: createDataLayer(config).repos,
      admin,
      bucket: config.supabase.bucket,
      predictor,
      dataset,
      dir: config.realDataDir,
      dryRun: args.dryRun,
      log,
    });
    return;
  }

  let repos;
  let staff;
  const bytes = { imagenes: 0, filas: 0 };
  if (args.dryRun) {
    // Simulación completa en memoria (mismas validaciones del dominio) + tamaños.
    repos = createDataLayer(buildConfig({ ...process.env, DATA_DRIVER: 'memory', NODE_ENV: 'test' })).repos;
    const { data: existentes } = await admin.from('patients').select('codigo').not('codigo', 'like', 'DEMO-%');
    log(`pacientes no demo ya cargados en Supabase: ${(existentes || []).length}`);
    staff = {
      medico: await repos.users.create({ id: crypto.randomUUID(), email: STAFF_KEYS.medico, role: 'medico' }),
    };
  } else {
    repos = createDataLayer(config).repos;
    const medico = await repos.users.findByEmail(STAFF_KEYS.medico);
    if (!medico) throw new Error(`no existe ${STAFF_KEYS.medico} en Supabase`);
    staff = { medico };
  }

  const authUsers = args.dryRun ? new Map() : await listAuthUsers(admin);
  const createIdentity = async (email) => {
    if (args.dryRun) return crypto.randomUUID();
    const existing = authUsers.get(email);
    if (existing) return existing.id;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: crypto.randomBytes(32).toString('base64url'), // no se guarda en ningún lado
      email_confirm: true,
      ban_duration: BAN_DURATION,
      app_metadata: { acceso: 'deshabilitado' },
    });
    if (error) throw new Error(`Auth: ${error.message}`);
    return data.user.id;
  };
  const saveImage = async ({ patient, studyId, slot, toma, dir }) => {
    const buffer = fs.readFileSync(path.join(dir, toma.imagen));
    bytes.imagenes += buffer.length;
    const key = `${patient.id}/${studyId}/${slot}.png`;
    if (!args.dryRun) {
      const { error } = await admin.storage
        .from(config.supabase.bucket)
        .upload(key, buffer, { contentType: 'image/png', upsert: true });
      if (error) throw new Error(`storage.upload: ${error.message}`);
    }
    return {
      slot,
      storagePath: key,
      mime: 'image/png',
      size: buffer.length,
      originalName: `${slot.toUpperCase()}.png`,
    };
  };

  const { resumen } = await seedRealData(
    { repos, predictor },
    {
      dataset,
      dir: config.realDataDir,
      staff,
      createIdentity,
      patientAccount: { email: patientEmail, activo: false },
      saveImage,
      skipExisting: true,
      log,
    },
  );
  if (args.dryRun) {
    const analyses = await repos.analyses.listAll();
    bytes.filas = analyses.reduce((s, a) => s + Buffer.byteLength(JSON.stringify(a)), 0);
  }
  log(
    `resumen: ${JSON.stringify(resumen)}; imágenes ${(bytes.imagenes / 1048576).toFixed(1)} MB` +
      (args.dryRun ? `; análisis ≈ ${(bytes.filas / 1048576).toFixed(1)} MB de JSON` : ''),
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error al cargar los datos reales:', err.message);
    process.exit(1);
  });
}

module.exports = {
  generatePassword,
  parseArgs,
  patientEmail,
  localModelFiles,
  refreshExisting,
  MOTIVO_NO_VALIDO_ANTERIOR,
  PATIENT_EMAIL_DOMAIN,
  BAN_DURATION,
};
