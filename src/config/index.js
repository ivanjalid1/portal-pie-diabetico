'use strict';

/**
 * Configuración de la aplicación (patrón Singleton).
 *
 * Se construye una única vez a partir de variables de entorno y se congela
 * para evitar mutaciones accidentales. Todo el resto del sistema recibe esta
 * configuración por inyección de dependencias desde la raíz de composición
 * (`src/container.js`).
 */
require('dotenv').config({ quiet: true });

let instance = null;

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'si', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function build(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const sessionSecret = env.SESSION_SECRET || 'dev-insecure-secret-cambiar-en-produccion';

  if (isProd && !env.SESSION_SECRET) {
    // En producción sin secreto explícito se usa uno efímero: las sesiones se
    // invalidan en cada arranque en frío, pero nunca se firma con el valor por defecto.
    console.warn('[config] SESSION_SECRET no definido: se usa un secreto efímero.');
  }

  return Object.freeze({
    env: nodeEnv,
    isProd,
    isTest: nodeEnv === 'test',
    port: int(env.PORT, 3000),
    appName: 'TermoPie',
    appUrl: env.APP_URL || 'http://localhost:3000',
    dataDriver: (env.DATA_DRIVER || 'memory').toLowerCase(),
    predictor: (env.PREDICTOR || 'mock').toLowerCase(),
    session: Object.freeze({
      name: 'tp_session',
      secret:
        isProd && !env.SESSION_SECRET
          ? require('node:crypto').randomBytes(32).toString('hex')
          : sessionSecret,
      maxAgeMs: int(env.SESSION_MAX_AGE_HOURS, 8) * 60 * 60 * 1000,
      secure: bool(env.COOKIE_SECURE, isProd),
    }),
    security: Object.freeze({
      loginRateLimitMax: int(env.LOGIN_RATE_LIMIT_MAX, nodeEnv === 'test' ? 1000 : 10),
      loginRateLimitWindowMs: int(env.LOGIN_RATE_LIMIT_WINDOW_MIN, 15) * 60 * 1000,
      bcryptRounds: int(env.BCRYPT_ROUNDS, nodeEnv === 'test' ? 4 : 10),
    }),
    uploads: Object.freeze({
      maxFileMb: int(env.MAX_UPLOAD_MB, 4),
    }),
    supabase: Object.freeze({
      url: env.SUPABASE_URL || '',
      anonKey: env.SUPABASE_ANON_KEY || '',
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
      bucket: env.SUPABASE_BUCKET || 'estudios',
      signedUrlTtlSeconds: int(env.SUPABASE_SIGNED_URL_TTL, 120),
    }),
    showDemoAccounts: bool(env.SHOW_DEMO_ACCOUNTS, true),
  });
}

/** Devuelve la instancia única de configuración. */
function getConfig() {
  if (!instance) instance = build();
  return instance;
}

module.exports = { getConfig, buildConfig: build };
