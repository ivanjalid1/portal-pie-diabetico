'use strict';

const crypto = require('node:crypto');
const { ROLE_HOME } = require('../models/roles');
const { AuthError } = require('../utils/errors');
const { EVENTS } = require('../utils/eventBus');

const DEMO_ACCOUNTS = [
  { rol: 'Médico/a', email: 'medico@demo.com', descripcion: 'Pacientes, estudios y análisis' },
  { rol: 'Paciente', email: 'paciente@demo.com', descripcion: 'Resultados y autocuidado' },
  { rol: 'Administrador', email: 'admin@demo.com', descripcion: 'Usuarios y auditoría' },
];

/** Sólo se aceptan rutas internas como destino posterior al login. */
function safeNext(next, role) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return null;
  const home = ROLE_HOME[role];
  return next.startsWith(home) || next.startsWith('/cuenta') ? next : null;
}

function createAuthController({ authService, events, config }) {
  return {
    showLogin(req, res) {
      res.render('public/login', {
        layout: 'public',
        title: 'Ingresar',
        next: typeof req.query.next === 'string' ? req.query.next : '',
        demoAccounts: config.showDemoAccounts ? DEMO_ACCOUNTS : [],
      });
    },

    async login(req, res) {
      const { email, password, next } = req.validated;
      try {
        const user = await authService.login(email, password, { ip: req.ip });
        // Nueva sesión (evita fijación de sesión): se reemplaza el contenido completo.
        req.session = {
          userId: user.id,
          role: user.role,
          csrf: crypto.randomBytes(24).toString('base64url'),
          iat: Date.now(),
        };
        req.session.flash = [{ type: 'success', message: `Hola, ${user.nombre || user.email}.` }];
        return res.redirect(303, safeNext(next, user.role) || ROLE_HOME[user.role]);
      } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        req.flash('error', err.message);
        req.flashForm({ email });
        const qs = next ? `?next=${encodeURIComponent(next)}` : '';
        return res.redirect(303, `/login${qs}`);
      }
    },

    logout(req, res) {
      if (req.user) {
        events.publish(EVENTS.USER_LOGOUT, {
          actor: { id: req.user.id, email: req.user.email, ip: req.ip },
          entity: 'usuario',
          entityId: req.user.id,
        });
      }
      req.session = { flash: [{ type: 'info', message: 'Cerraste sesión correctamente.' }] };
      res.redirect(303, '/login');
    },

    showChangePassword(req, res) {
      res.render('cuenta/password', { title: 'Cambiar contraseña', forced: req.user.mustChangePassword });
    },

    async changePassword(req, res) {
      const { actual, nueva } = req.validated;
      await authService.changePassword(req.user, actual, nueva, { ip: req.ip });
      req.flash('success', 'Actualizaste tu contraseña.');
      res.redirect(303, ROLE_HOME[req.user.role]);
    },
  };
}

module.exports = { createAuthController, safeNext, DEMO_ACCOUNTS };
