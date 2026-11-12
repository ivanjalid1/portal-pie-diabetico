'use strict';

/**
 * Clientes de Supabase (patrón Singleton).
 *
 * - `admin`: usa la service-role key. SÓLO en el servidor; omite RLS, por eso
 *   la autorización por objeto se aplica además en la capa de servicios.
 * - `createAnon()`: cliente efímero con la anon key, usado para validar
 *   credenciales con Supabase Auth sin compartir sesión entre peticiones.
 */
const { createClient } = require('@supabase/supabase-js');

let clients = null;

const SERVER_AUTH = Object.freeze({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });

function getSupabaseClients(config) {
  if (clients) return clients;
  const { url, anonKey, serviceRoleKey } = config.supabase;
  if (!url || !serviceRoleKey || !anonKey) {
    throw new Error(
      'DATA_DRIVER=supabase requiere SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY (ver .env.example).',
    );
  }
  clients = Object.freeze({
    admin: createClient(url, serviceRoleKey, { auth: SERVER_AUTH }),
    createAnon: () => createClient(url, anonKey, { auth: SERVER_AUTH }),
  });
  return clients;
}

/** Sólo para tests. */
function resetSupabaseClients() {
  clients = null;
}

module.exports = { getSupabaseClients, resetSupabaseClients };
