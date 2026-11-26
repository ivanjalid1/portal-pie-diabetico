#!/usr/bin/env node
'use strict';

/**
 * Sube al almacenamiento PRIVADO de Supabase (bucket `estudios`) lo que el
 * visor de termogramas necesita en producción, para cada estudio real ya
 * cargado (scripts/seed-supabase-real.js) y cada réplica de sus tomas:
 *
 *   termica/<paciente>/<estudio>/toma<k>-r<n>.tpv   matriz de temperaturas TPV1, gzip
 *   visible/<paciente>/<estudio>/toma<k>-r<n>.jpg   foto visible del IS2 (re-codificada, sin metadatos)
 *   termica/<paciente>/<estudio>/visor.json         manifiesto: réplicas, calidad y metadatos de captura
 *
 * Fuentes locales: data-local/ml/cache (matrices por réplica, clave = hash de
 * la ruta del IS2) y la carpeta privada tesis-2026info/ (sólo se LEEN los IS2
 * como datos). Nada de esto pasa por git ni por Vercel. El servidor sirve
 * estos archivos sólo por las rutas autenticadas del visor (médico tratante).
 *
 * El script no imprime nombres ni datos personales: sólo códigos agregados.
 *
 * Uso: node scripts/upload-visor-real.js [--dry-run] [--sin-fotos]
 */
require('dotenv').config({ quiet: true });
const path = require('node:path');
const zlib = require('node:zlib');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const sinFotos = process.argv.includes('--sin-fotos');
  const { buildConfig } = require('../src/config');
  const { createDataLayer } = require('../src/repositories/RepositoryFactory');
  const { getSupabaseClients } = require('../src/config/supabase');
  const { MaskService } = require('../src/services/MaskService');
  const { ThermalViewerService, REMOTE } = require('../src/services/ThermalViewerService');

  const config = buildConfig({ ...process.env, DATA_DRIVER: 'supabase' });
  const { admin } = getSupabaseClients(config);
  const repos = createDataLayer(config).repos;
  const maskService = new MaskService({ dir: config.localDataDir });
  if (!maskService.enabled) throw new Error('falta data-local/ml/cache (matrices por réplica)');
  const privateDir = path.join(__dirname, '..', 'tesis-2026info');
  const viewer = new ThermalViewerService({ maskService, privateDir: sinFotos ? null : privateDir });
  console.log(`${dryRun ? '[dry-run] ' : ''}Supabase: ${config.supabase.url} · fotos: ${!sinFotos}`);

  const upload = async (key, buffer, contentType) => {
    if (dryRun) return;
    const { error } = await admin.storage
      .from(config.supabase.bucket)
      .upload(key, buffer, { contentType, upsert: true });
    if (error) throw new Error(`storage.upload: ${error.message}`);
  };

  const { data: pats, error } = await admin.from('patients').select('id, codigo').not('codigo', 'like', 'DEMO-%');
  if (error) throw error;
  const tot = { estudios: 0, replicas: 0, fotos: 0, bytesTermica: 0, bytesFotos: 0, maxFoto: 0, sinReplicas: 0 };
  for (const p of pats) {
    const patient = { id: p.id, codigo: p.codigo };
    const [study] = await repos.studies.listByPatient(p.id);
    if (!study) continue;
    const fuentes = (await viewer.sources(study, patient)).filter((f) => f.origen === 'real');
    if (!fuentes.length) {
      tot.sinReplicas += 1;
      continue;
    }
    const entries = (toma) => viewer.realEntries(patient.codigo, toma);
    for (const f of fuentes) {
      for (const r of f.reps) {
        const e = entries(f.toma).find((x) => x.rep + 1 === r.rep);
        const gz = zlib.gzipSync(viewer.thermalByKey(e.key), { level: 9 });
        tot.bytesTermica += gz.length;
        await upload(REMOTE.thermal(study, f.toma, r.rep), gz, 'application/octet-stream');
        tot.replicas += 1;
        if (r.foto) {
          const jpeg = viewer.visibleByKey(e.key);
          if (jpeg) {
            tot.fotos += 1;
            tot.bytesFotos += jpeg.length;
            tot.maxFoto = Math.max(tot.maxFoto, jpeg.length);
            await upload(REMOTE.visible(study, f.toma, r.rep), jpeg, 'image/jpeg');
          } else r.foto = false;
        }
      }
    }
    const manifest = {
      version: 1,
      generado: new Date().toISOString(),
      tomas: fuentes.map((f) => ({ toma: f.toma, reps: f.reps })),
    };
    await upload(REMOTE.manifest(study), Buffer.from(JSON.stringify(manifest)), 'application/octet-stream');
    tot.estudios += 1;
  }
  const mb = (b) => (b / 1048576).toFixed(1);
  console.log(
    `  estudios ${tot.estudios} (sin réplicas exportadas: ${tot.sinReplicas}) · réplicas ${tot.replicas} ` +
      `(${mb(tot.bytesTermica)} MB) · fotos ${tot.fotos} (${mb(tot.bytesFotos)} MB, máx. ${(tot.maxFoto / 1024).toFixed(0)} KB)`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error al subir los datos del visor:', err.message);
    process.exit(1);
  });
}
