'use strict';

const crypto = require('node:crypto');
const { AppError } = require('../utils/errors');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Protección CSRF con token sincronizado guardado en la sesión firmada.
 * Los formularios incluyen `<input name="_csrf">`; las peticiones fetch, el
 * encabezado `X-CSRF-Token`.
 *
 * Los formularios multipart se verifican DESPUÉS de multer (el cuerpo todavía
 * no está parseado en este punto) con `verifyCsrf` en la ruta correspondiente.
 */
function csrfToken(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('base64url');
  res.locals.csrfToken = req.session.csrf;
  next();
}

function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function verifyCsrf(req, _res, next) {
  if (SAFE.has(req.method)) return next();
  const sent = req.body?._csrf || req.get('x-csrf-token');
  if (!tokensMatch(sent, req.session?.csrf)) {
    return next(new AppError('El formulario venció o no es válido. Recargá la página e intentá de nuevo.', 403, 'csrf'));
  }
  return next();
}

/** Verificación global salvo multipart (que se verifica en la ruta). */
function csrfProtection(req, res, next) {
  if (SAFE.has(req.method)) return next();
  if (req.is('multipart/form-data')) return next();
  return verifyCsrf(req, res, next);
}

module.exports = { csrfToken, csrfProtection, verifyCsrf };
