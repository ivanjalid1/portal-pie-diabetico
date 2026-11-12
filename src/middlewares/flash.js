'use strict';

/**
 * Mensajes flash + "old input" sobre la sesión firmada (cookie).
 * Se consumen en la siguiente petición GET que renderiza una vista.
 */
function flash(req, res, next) {
  req.flash = (type, message) => {
    req.session.flash = [...(req.session.flash || []), { type, message }];
  };
  req.flashForm = (old, errors) => {
    const { _csrf, password, nueva, actual, confirmacion, ...safe } = old || {};
    req.session.form = { old: safe, errors: errors || {} };
  };

  res.locals.flashes = req.session.flash || [];
  const form = req.session.form || { old: {}, errors: {} };
  res.locals.old = form.old || {};
  res.locals.errors = form.errors || {};
  if (req.method === 'GET') {
    delete req.session.flash;
    delete req.session.form;
  }
  next();
}

module.exports = { flash };
