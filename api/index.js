'use strict';

/**
 * Punto de entrada serverless para Vercel: exporta la app Express.
 * Vercel reutiliza la instancia mientras la función permanezca "tibia".
 */
const { createApp } = require('../src/app');

module.exports = createApp();
