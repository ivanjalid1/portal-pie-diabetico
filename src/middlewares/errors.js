'use strict';

const multer = require('multer');
const { AppError, ValidationError } = require('../utils/errors');

function notFound(req, res) {
  res.status(404).render('errors/error', {
    title: 'Página no encontrada',
    status: 404,
    message: 'La dirección que buscás no existe o fue movida.',
  });
}

function backUrl(req, err) {
  if (err.back) return err.back;
  const ref = req.get('referer');
  try {
    if (ref) {
      const u = new URL(ref);
      if (u.host === req.get('host')) return u.pathname + u.search;
    }
  } catch {
    /* referer inválido */
  }
  return req.originalUrl;
}

/** Manejador central de errores (último eslabón de la cadena). */
function errorHandler(err, req, res, _next) {
  let error = err;
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Una de las imágenes supera el tamaño máximo permitido.'
        : 'No se pudieron procesar los archivos enviados.';
    error = new ValidationError(msg, {});
  }

  // Errores de formulario: volver al formulario con mensaje y datos cargados.
  if (error instanceof AppError && (error.status === 422 || error.status === 409) && req.method !== 'GET') {
    if (req.flash) {
      req.flash('error', error.message);
      req.flashForm(req.body, error.fields || {});
    }
    return res.redirect(303, backUrl(req, error));
  }

  const status = error instanceof AppError ? error.status : 500;
  if (status >= 500) console.error('[error]', err);

  const titles = { 401: 'Sesión vencida', 403: 'Acceso denegado', 404: 'Página no encontrada' };
  return res.status(status).render('errors/error', {
    title: titles[status] || 'Algo salió mal',
    status,
    message:
      status >= 500
        ? 'Ocurrió un error inesperado al procesar la solicitud. Probá de nuevo en unos minutos.'
        : error.message,
  });
}

module.exports = { notFound, errorHandler };
