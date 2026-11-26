'use strict';

const path = require('node:path');

/**
 * Carpeta local de trabajo (data-local/, ignorada por git y Vercel).
 * LOCAL_DATA_DIR la reemplaza: así un checkout secundario (otra copia del
 * repositorio) puede usar los modelos y datos locales sin duplicarlos.
 */
const localDataDir = () => process.env.LOCAL_DATA_DIR || path.join(__dirname, '..', '..', 'data-local');

/** Ruta dentro de la carpeta local de trabajo. */
const localDataPath = (...parts) => path.join(localDataDir(), ...parts);

module.exports = { localDataDir, localDataPath };
