#!/usr/bin/env node
'use strict';

/**
 * Carga los datos de demostración en Supabase (Auth + Postgres + Storage)
 * usando los mismos repositorios que la aplicación (driver `supabase`).
 *
 * Requiere en .env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
 * Es idempotente a nivel de usuario/paciente: si ya existen, no se duplican.
 *
 * Uso: npm run seed:supabase
 *      npm run seed:supabase -- --reset   (borra los datos demo antes de cargar)
 */
require('dotenv').config({ quiet: true });
const { buildConfig } = require('../src/config');
const { createDataLayer } = require('../src/repositories/RepositoryFactory');
const { createPredictor } = require('../src/services/predictors/PredictorFactory');
const { seedDemoData } = require('../src/seed');
const { STAFF, PATIENTS } = require('../src/seed/demoData');
const { getSupabaseClients } = require('../src/config/supabase');

async function reset(config) {
  const { admin } = getSupabaseClients(config);
  const emails = new Set([...STAFF.map((s) => s.email), ...PATIENTS.map((p) => p.personal.email)]);
  // Borrar datos clínicos de los médicos demo (las FK en cascada limpian el resto).
  const { data: medicos } = await admin
    .from('profiles')
    .select('id')
    .in('email', [...emails])
    .eq('role', 'medico');
  const ids = (medicos || []).map((m) => m.id);
  if (ids.length) {
    await admin.from('appointments').delete().in('medico_id', ids);
    const { data: pats } = await admin.from('patients').select('id').in('medico_id', ids);
    const patientIds = (pats || []).map((p) => p.id);
    if (patientIds.length) {
      // Imágenes del bucket.
      for (const pid of patientIds) {
        const { data: studies } = await admin.storage.from(config.supabase.bucket).list(pid);
        for (const s of studies || []) {
          const { data: files } = await admin.storage.from(config.supabase.bucket).list(`${pid}/${s.name}`);
          const paths = (files || []).map((f) => `${pid}/${s.name}/${f.name}`);
          if (paths.length) await admin.storage.from(config.supabase.bucket).remove(paths);
        }
      }
      await admin.from('studies').delete().in('patient_id', patientIds);
      await admin.from('patients').delete().in('id', patientIds);
    }
  }
  await admin.from('audit_log').delete().neq('action', '__never__');
  // Usuarios de Auth (el perfil se borra en cascada).
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    for (const u of data.users) {
      if (emails.has(String(u.email).toLowerCase())) await admin.auth.admin.deleteUser(u.id);
    }
    if (data.users.length < 200) break;
    page += 1;
  }
  console.log('Datos demo anteriores eliminados.');
}

async function main() {
  const config = buildConfig({ ...process.env, DATA_DRIVER: 'supabase' });
  if (process.argv.includes('--reset')) await reset(config);
  const { repos, authProvider } = createDataLayer(config);
  const predictor = createPredictor(config.predictor);
  console.log(`Sembrando datos demo en ${config.supabase.url} ...`);
  await seedDemoData({ repos, authProvider, predictor }, { uploadImages: true, log: (m) => console.log(`  + ${m}`) });
  console.log('Listo. Cuentas demo con contraseña Demo1234!');
}

main().catch((err) => {
  console.error('Error al sembrar Supabase:', err.message);
  process.exit(1);
});
