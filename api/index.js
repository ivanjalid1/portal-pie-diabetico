'use strict';

/**
 * Punto de entrada serverless para Vercel: exporta la app Express.
 * Vercel reutiliza la instancia mientras la función permanezca "tibia".
 *
 * Con DATA_DRIVER=supabase, en el arranque en frío se descargan primero los
 * modelos del bucket privado `modelos` (src/config/remoteModels.js) y recién
 * después se carga la aplicación, porque algunos cargadores leen su ruta al
 * importarse.
 */
const { ensureRemoteModels, remoteModelsEnabled } = require('../src/config/remoteModels');

let ready = null;

async function boot() {
  if (remoteModelsEnabled(process.env)) {
    try {
      const { createClient } = require('@supabase/supabase-js');
      const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      await ensureRemoteModels({ client, log: (m) => console.log(`[boot] ${m}`) });
    } catch (err) {
      // Sin modelos la aplicación funciona igual (sin pronóstico ni prior de neuropatía).
      console.warn(`[boot] no se pudieron cargar los modelos: ${err.message}`);
    }
  }
  return require('../src/app').createApp();
}

module.exports = async function handler(req, res) {
  if (!ready)
    ready = boot().catch((err) => {
      ready = null;
      throw err;
    });
  const app = await ready;
  return app(req, res);
};
