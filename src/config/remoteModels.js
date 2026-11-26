'use strict';

/**
 * Modelos locales derivados de datos reales, servidos desde Supabase Storage.
 *
 * En local viven en data-local/ (ignorada por git y Vercel). En producción
 * (DATA_DRIVER=supabase) están en el bucket privado `modelos` y se descargan
 * una vez por arranque en frío a una carpeta temporal (/tmp en Vercel). Cada
 * archivo se expone con la misma variable de entorno que ya acepta su
 * cargador, por lo que hay que llamar a `ensureRemoteModels` ANTES de cargar
 * la aplicación (el atlas de angiosomas se lee al cargar src/imaging/tci.js).
 *
 * Una variable ya definida no se toca. Si un archivo falta o falla la
 * descarga, esa función queda deshabilitada (igual que sin el archivo local).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODELS_BUCKET = 'modelos';

/**
 * Archivos del bucket → variable de entorno de su cargador.
 * `dir: true`: la variable apunta a la carpeta (TCI_REFERENCE_DIR busca tci-reference.json).
 */
const REMOTE_MODELS = Object.freeze([
  { file: 'forecast-zones.json', env: 'PRONOSTICO_MODELO', local: ['models', 'forecast-zones.json'] },
  {
    file: 'riskfactor-neuropatia-cnn.json',
    env: 'RIESGO_FACTOR_MODELO',
    local: ['models', 'riskfactor-neuropatia-cnn.json'],
  },
  { file: 'angiosome-atlas.json', env: 'ANGIOSOME_ATLAS', local: ['models', 'angiosome-atlas.json'] },
  { file: 'outcome-logreg.json', env: 'OUTCOME_MODEL', local: ['models', 'outcome-logreg.json'] },
  { file: 'tci-reference.json', env: 'TCI_REFERENCE_DIR', dir: true, local: ['real', 'tci-reference.json'] },
]);

const defaultCacheDir = () => path.join(os.tmpdir(), 'termopie-modelos');

/** ¿Corresponde descargar los modelos? Sólo con Supabase y salvo MODELS_BUCKET vacío / "none". */
function remoteModelsEnabled(env = process.env) {
  const bucket = env.MODELS_BUCKET;
  return (
    String(env.DATA_DRIVER || '').toLowerCase() === 'supabase' &&
    env.NODE_ENV !== 'test' &&
    bucket !== '' &&
    String(bucket).toLowerCase() !== 'none'
  );
}

/**
 * Descarga los modelos del bucket y define sus variables de entorno.
 * @param {object} opts
 * @param {{storage: {from: Function}}} opts.client cliente de Supabase con la service role
 * @param {object} [opts.env] process.env (se modifica)
 * @param {string} [opts.bucket]
 * @param {string} [opts.cacheDir]
 * @returns {Promise<{cargados: string[], faltantes: string[], omitidos: string[]}>}
 */
async function ensureRemoteModels({
  client,
  env = process.env,
  bucket = env.MODELS_BUCKET || MODELS_BUCKET,
  cacheDir = defaultCacheDir(),
  log = () => {},
}) {
  const out = { cargados: [], faltantes: [], omitidos: [] };
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const m of REMOTE_MODELS) {
    if (env[m.env] !== undefined && env[m.env] !== '') {
      out.omitidos.push(m.file);
      continue;
    }
    const target = path.join(cacheDir, m.file);
    if (!fs.existsSync(target)) {
      try {
        const { data, error } = await client.storage.from(bucket).download(m.file);
        if (error || !data) throw error || new Error('sin datos');
        const tmp = `${target}.${process.pid}.part`;
        fs.writeFileSync(tmp, Buffer.from(await data.arrayBuffer()));
        fs.renameSync(tmp, target);
      } catch {
        out.faltantes.push(m.file);
        continue;
      }
    }
    env[m.env] = m.dir ? cacheDir : target;
    out.cargados.push(m.file);
  }
  log(`modelos: ${out.cargados.length} cargados${out.faltantes.length ? `, sin ${out.faltantes.join(', ')}` : ''}`);
  return out;
}

module.exports = { ensureRemoteModels, remoteModelsEnabled, REMOTE_MODELS, MODELS_BUCKET, defaultCacheDir };
