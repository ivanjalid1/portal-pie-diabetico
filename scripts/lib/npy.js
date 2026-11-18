'use strict';

/**
 * Lectura/escritura .npy (src/utils/npy.js) y clave no identificatoria de los
 * archivos IS2, para los scripts de scripts/ml/.
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { writeNpy, readNpy } = require('../../src/utils/npy');

/**
 * Clave estable y no identificatoria de un archivo IS2: hash de su ruta
 * relativa (las carpetas de origen pueden llevar el nombre del paciente).
 */
const is2Key = (root, file) =>
  crypto.createHash('sha1').update(path.relative(root, file).split(path.sep).join('/')).digest('hex').slice(0, 16);

module.exports = { writeNpy, readNpy, is2Key };
