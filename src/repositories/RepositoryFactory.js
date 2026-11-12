'use strict';

/**
 * Fábrica de repositorios (patrón Factory).
 *
 * Según `DATA_DRIVER` devuelve el conjunto de repositorios y el proveedor de
 * identidad correspondientes. El resto de la aplicación no sabe si trabaja
 * con memoria o con Supabase.
 */
const { createMemoryRepositories } = require('./memory');
const PasswordAuthProvider = require('../services/auth/PasswordAuthProvider');

function createDataLayer(config) {
  switch (config.dataDriver) {
    case 'memory': {
      const repos = createMemoryRepositories();
      const authProvider = new PasswordAuthProvider({
        users: repos.users,
        credentials: repos.credentials,
        rounds: config.security.bcryptRounds,
      });
      return { driver: 'memory', repos, authProvider };
    }
    case 'supabase': {
      // Carga diferida: el SDK sólo se requiere si se usa este driver.
      const { createSupabaseRepositories } = require('./supabase');
      const SupabaseAuthProvider = require('../services/auth/SupabaseAuthProvider');
      const { getSupabaseClients } = require('../config/supabase');
      const clients = getSupabaseClients(config);
      const repos = createSupabaseRepositories(clients.admin, config);
      const authProvider = new SupabaseAuthProvider({ clients });
      return { driver: 'supabase', repos, authProvider };
    }
    default:
      throw new Error(`DATA_DRIVER desconocido: "${config.dataDriver}". Valores válidos: memory, supabase.`);
  }
}

module.exports = { createDataLayer };
