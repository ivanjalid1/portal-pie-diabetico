'use strict';

const domain = require('../config/domain');
const { fmt } = require('../utils/format');
const thermal = require('../utils/thermal');
const { ROLE_LABELS, ROLE_HOME } = require('../models/roles');

/** Navegación lateral por rol (íconos definidos en partials/icon.ejs). */
const NAV = {
  admin: [
    { href: '/admin', label: 'Resumen', icon: 'gauge', exact: true },
    { href: '/admin/usuarios', label: 'Usuarios', icon: 'users' },
    { href: '/admin/auditoria', label: 'Auditoría', icon: 'list' },
  ],
  medico: [
    { href: '/medico', label: 'Tablero', icon: 'gauge', exact: true },
    { href: '/medico/pacientes', label: 'Pacientes', icon: 'users' },
    { href: '/medico/estudios/nuevo', label: 'Nuevo estudio', icon: 'scan' },
    { href: '/medico/controles', label: 'Controles', icon: 'calendar' },
  ],
  paciente: [
    { href: '/paciente', label: 'Inicio', icon: 'home', exact: true },
    { href: '/paciente/estudios', label: 'Mis estudios', icon: 'scan' },
    { href: '/paciente/controles', label: 'Mis controles', icon: 'calendar' },
    { href: '/paciente/autocuidado', label: 'Cuidado de los pies', icon: 'heart' },
    { href: '/paciente/datos', label: 'Mis datos', icon: 'user' },
  ],
};

function locals(config) {
  return function localsMiddleware(req, res, next) {
    res.locals.fmt = fmt;
    res.locals.thermal = thermal;
    const isIs2 = (img) => img?.mime === 'application/x-fluke-is2';
    // Los IS2 se muestran como PNG generado en el servidor (?vista=png).
    res.locals.imageUrl = (study, slot) =>
      `/media/estudios/${study.id}/${slot}${isIs2(study.image?.(slot)) ? '?vista=png' : ''}`;
    res.locals.canPreview = (img) =>
      Boolean(img && (img.publicUrl || isIs2(img) || domain.PREVIEWABLE_TYPES.includes(img.mime)));
    res.locals.domain = domain;
    res.locals.appName = config.appName;
    res.locals.currentPath = req.path;
    res.locals.ROLE_LABELS = ROLE_LABELS;
    res.locals.ROLE_HOME = ROLE_HOME;
    res.locals.title = config.appName;
    res.locals.isActive = (item) =>
      item.exact ? req.path === item.href : req.path === item.href || req.path.startsWith(`${item.href}/`);
    res.locals.navFor = (role) => NAV[role] || [];
    res.locals.dataDriver = config.dataDriver;
    next();
  };
}

/**
 * Envuelve cada vista en un layout. Por defecto usa `app` (con barra lateral)
 * si hay sesión y `public` si no; una vista puede pedir otro con `layout`, o
 * ninguno con `layout: false` (p. ej. el informe imprimible).
 */
function layouts(req, res, next) {
  const render = res.render.bind(res);
  res.render = (view, options = {}, callback) => {
    const opts = { ...options };
    const layout = opts.layout === undefined ? (req.user ? 'app' : 'public') : opts.layout;
    if (!layout) return render(view, opts, callback);
    return render(view, opts, (err, body) => {
      if (err) return req.next(err);
      return render(`layouts/${layout}`, { ...opts, body }, callback);
    });
  };
  next();
}

module.exports = { locals, layouts, NAV };
