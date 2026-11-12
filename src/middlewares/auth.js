'use strict';

/**
 * Eslabones de autenticación y autorización de la cadena de middlewares
 * (patrón Chain of Responsibility): cada eslabón decide si corta la petición
 * (redirección / 403) o la pasa al siguiente con `next()`.
 */
const { ROLE_HOME } = require('../models/roles');
const { ForbiddenError } = require('../utils/errors');

/** Carga el usuario de la sesión (si existe) y lo expone a las vistas. */
function loadUser(authService) {
  return async function loadUserMiddleware(req, res, next) {
    res.locals.user = null;
    const userId = req.session?.userId;
    if (!userId) return next();
    const user = await authService.getUser(userId);
    if (!user || !user.activo) {
      req.session = null;
      return next();
    }
    req.user = user;
    res.locals.user = user;
    return next();
  };
}

/** Exige sesión iniciada. */
function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') {
    const target = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?next=${target}`);
  }
  return res.status(401).render('errors/error', {
    layout: 'public',
    title: 'Sesión vencida',
    status: 401,
    message: 'Tu sesión terminó. Iniciá sesión nuevamente.',
  });
}

/** Exige uno de los roles indicados (RBAC). */
function requireRole(...roles) {
  return function requireRoleMiddleware(req, _res, next) {
    if (!req.user) return next(new ForbiddenError());
    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenError('Tu rol no tiene acceso a esta sección.'));
    }
    return next();
  };
}

/** Obliga a cambiar la contraseña temporal antes de usar el portal. */
function enforcePasswordChange(req, res, next) {
  if (!req.user?.mustChangePassword) return next();
  const allowed = ['/cuenta/password', '/logout'];
  if (allowed.includes(req.path)) return next();
  if (req.method === 'GET') return res.redirect('/cuenta/password');
  return next(new ForbiddenError('Primero cambiá tu contraseña temporal.'));
}

/** Redirige al inicio de su rol a quien ya inició sesión (p. ej. en /login). */
function redirectIfAuthenticated(req, res, next) {
  if (req.user) return res.redirect(ROLE_HOME[req.user.role] || '/');
  return next();
}

module.exports = { loadUser, requireAuth, requireRole, enforcePasswordChange, redirectIfAuthenticated };
