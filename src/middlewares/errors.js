'use strict';

const multer = require('multer');
const { AppError, ValidationError } = require('../utils/errors');
const { ROLE_HOME } = require('../models/roles');

/**
 * Dibuja la página de error. El error puede ocurrir antes de que corran los
 * middlewares que cargan la sesión (`user`) o los datos comunes de las vistas
 * (p. ej. un token CSRF inválido o un cuerpo mal formado): por eso se pasan
 * siempre `user` y `ROLE_HOME` explícitos.
 */
function renderError(req, res, { status, title, message }) {
  return res.status(status).render('errors/error', {
    title,
    status,
    message,
    user: res.locals.user ?? req.user ?? null,
    ROLE_HOME,
    appName: res.locals.appName || 'Portal',
    currentPath: res.locals.currentPath || req.path,
  });
}

function notFound(req, res) {
  renderError(req, res, {
    title: 'Página no encontrada',
    status: 404,
    message: 'La dirección que buscás no existe o fue movida.',
  });
}

/** Errores 4xx de los parsers de Express (cuerpo mal formado o demasiado grande). */
const clientStatus = (err) => {
  const st = Number(err?.status ?? err?.statusCode);
  return err?.expose && st >= 400 && st < 500 ? st : null;
};

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

  // Peticiones fetch con cuerpo JSON o que piden JSON (mejora progresiva de formularios).
  const wantsJson = Boolean(req.is('application/json')) || req.accepts(['html', 'json']) === 'json';

  // Errores de formulario: volver al formulario con mensaje y datos cargados.
  if (
    !wantsJson &&
    error instanceof AppError &&
    (error.status === 422 || error.status === 409) &&
    req.method !== 'GET'
  ) {
    if (req.flash) {
      req.flash('error', error.message);
      req.flashForm(req.body, error.fields || {});
    }
    return res.redirect(303, backUrl(req, error));
  }

  const status = error instanceof AppError ? error.status : clientStatus(error) || 500;
  if (status >= 500) console.error('[error]', err);

  // Peticiones fetch (p. ej. la corrección de máscaras o la revisión de fotos): respuesta JSON.
  if (wantsJson) {
    return res.status(status).json({
      error:
        status >= 500
          ? 'Ocurrió un error inesperado. Probá de nuevo.'
          : error instanceof AppError
            ? error.message
            : 'La solicitud no es válida.',
      ...(error.fields && Object.keys(error.fields).length ? { fields: error.fields } : {}),
    });
  }

  const titles = { 401: 'Sesión vencida', 403: 'Acceso denegado', 404: 'Página no encontrada' };
  return renderError(req, res, {
    title: titles[status] || 'Algo salió mal',
    status,
    message:
      status >= 500
        ? 'Ocurrió un error inesperado al procesar la solicitud. Probá de nuevo en unos minutos.'
        : error instanceof AppError
          ? error.message
          : 'La solicitud no es válida.',
  });
}

module.exports = { notFound, errorHandler };
