'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');
const { buildContainer } = require('./container');
const { loadUser, enforcePasswordChange } = require('./middlewares/auth');
const { csrfToken, csrfProtection } = require('./middlewares/csrf');
const { flash } = require('./middlewares/flash');
const { locals, layouts } = require('./middlewares/locals');
const { notFound, errorHandler } = require('./middlewares/errors');
const buildRoutes = require('./routes');

/**
 * Crea la aplicación Express (capa de presentación del patrón MVC).
 * Recibe un contenedor ya armado, o lo construye con la configuración actual.
 */
function createApp(container = buildContainer()) {
  const { config, services } = container;
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:', 'blob:', 'https://*.supabase.co'],
          connectSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: config.isProd ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      maxAge: config.isProd ? '7d' : 0,
      index: false,
    }),
  );

  app.use(express.urlencoded({ extended: true, limit: '200kb' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(
    cookieSession({
      name: config.session.name,
      keys: [config.session.secret],
      maxAge: config.session.maxAgeMs,
      httpOnly: true,
      sameSite: 'lax',
      secure: config.session.secure,
    }),
  );

  // Espera a que la semilla de datos (driver memory) esté cargada.
  app.use(async (_req, _res, next) => {
    await container.ready;
    next();
  });

  // Cadena de responsabilidad global: locals → layout → flash → CSRF → usuario.
  app.use(locals(config));
  app.use(layouts);
  app.use(flash);
  app.use(csrfToken);
  app.use(csrfProtection);
  app.use(loadUser(services.authService));
  app.use(enforcePasswordChange);
  app.use((req, res, next) => {
    res.set('Cache-Control', req.user ? 'no-store' : 'no-cache');
    next();
  });

  app.use(buildRoutes(container));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
