'use strict';

const { ValidationError } = require('../utils/errors');

/** Convierte los issues de Zod en `{ campo: mensaje }` (el primero por campo). */
function issuesToFields(issues) {
  const fields = {};
  for (const issue of issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}

/**
 * Eslabón de validación de la cadena: valida `req[source]` con un esquema Zod.
 * Si es válido deja el resultado tipado en `req.validated`; si no, corta la
 * cadena con un `ValidationError` que el manejador de errores convierte en
 * mensaje flash + redirección al formulario con los datos cargados.
 */
function validate(schema, { source = 'body', back } = {}) {
  return function validateMiddleware(req, _res, next) {
    const result = schema.safeParse(req[source] || {});
    if (result.success) {
      req.validated = result.data;
      return next();
    }
    const err = new ValidationError('Revisá los campos marcados.', issuesToFields(result.error.issues));
    if (back) err.back = typeof back === 'function' ? back(req) : back;
    return next(err);
  };
}

module.exports = { validate, issuesToFields };
