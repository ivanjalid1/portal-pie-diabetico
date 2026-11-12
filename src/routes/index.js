'use strict';

const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { ROLES } = require('../models/roles');
const { IMAGE_SLOTS } = require('../config/domain');
const { requireAuth, requireRole, redirectIfAuthenticated } = require('../middlewares/auth');
const { verifyCsrf } = require('../middlewares/csrf');
const { validate } = require('../middlewares/validate');
const schemas = require('../validators/schemas');
const { createAuthController } = require('../controllers/authController');
const { createPublicController } = require('../controllers/publicController');
const { createAdminController } = require('../controllers/adminController');
const { createMedicoController } = require('../controllers/medicoController');
const { createPacienteController } = require('../controllers/pacienteController');
const { createMediaController } = require('../controllers/mediaController');

/**
 * Definición de rutas. Cada ruta protegida arma su cadena de responsabilidad:
 *   requireAuth → requireRole(rol) → [multer] → [verifyCsrf] → validate(schema) → controlador
 */
function buildRoutes(container) {
  const { config, services, events } = container;
  const router = express.Router();

  const auth = createAuthController({ authService: services.authService, events, config });
  const pub = createPublicController({ config, analysisService: services.analysisService });
  const admin = createAdminController(services);
  const medico = createMedicoController({ ...services, events, config });
  const paciente = createPacienteController(services);
  const media = createMediaController(services);

  const loginLimiter = rateLimit({
    windowMs: config.security.loginRateLimitWindowMs,
    limit: config.security.loginRateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      req.flash('error', 'Demasiados intentos de ingreso. Esperá unos minutos y volvé a intentar.');
      res.redirect(303, '/login');
    },
  });

  // Carga en memoria (sin disco: compatible con serverless).
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.uploads.maxFileMb * 1024 * 1024, files: IMAGE_SLOTS.length, fields: 60 },
  }).fields(IMAGE_SLOTS.map(({ slot }) => ({ name: slot, maxCount: 1 })));

  /* ---------- Público ---------- */
  router.get('/', pub.home);
  router.get('/salud', pub.health);
  router.get('/login', redirectIfAuthenticated, auth.showLogin);
  router.post('/login', loginLimiter, validate(schemas.loginSchema, { back: '/login' }), auth.login);
  router.post('/logout', auth.logout);

  /* ---------- Cuenta ---------- */
  router.get('/cuenta/password', requireAuth, auth.showChangePassword);
  router.post(
    '/cuenta/password',
    requireAuth,
    validate(schemas.changePasswordSchema, { back: '/cuenta/password' }),
    auth.changePassword,
  );

  /* ---------- Administración ---------- */
  const a = express.Router();
  a.use(requireAuth, requireRole(ROLES.ADMIN));
  a.get('/', admin.dashboard);
  a.get('/usuarios', admin.users);
  a.get('/usuarios/nuevo-medico', admin.newMedico);
  a.post(
    '/usuarios/medicos',
    validate(schemas.medicoSchema, { back: '/admin/usuarios/nuevo-medico' }),
    admin.createMedico,
  );
  a.post('/usuarios/:id/estado', admin.toggleActive);
  a.post('/usuarios/:id/restablecer', admin.resetPassword);
  a.get('/auditoria', admin.audit);
  router.use('/admin', a);

  /* ---------- Médico/a ---------- */
  const m = express.Router();
  m.use(requireAuth, requireRole(ROLES.MEDICO));
  m.get('/', medico.dashboard);
  m.get('/pacientes', medico.patients);
  m.get('/pacientes/nuevo', medico.newPatient);
  m.get('/pacientes/exportar.csv', medico.exportCsv);
  m.post(
    '/pacientes',
    validate(schemas.patientCreateSchema, { back: '/medico/pacientes/nuevo' }),
    medico.createPatient,
  );
  m.get('/pacientes/:id', medico.patientDetail);
  m.get('/pacientes/:id/editar', medico.editPatient);
  m.post(
    '/pacientes/:id',
    validate(schemas.patientUpdateSchema, { back: (req) => `/medico/pacientes/${req.params.id}/editar` }),
    medico.updatePatient,
  );
  m.post(
    '/pacientes/:id/desenlace',
    validate(schemas.outcomeSchema, { back: (req) => `/medico/pacientes/${req.params.id}#desenlace` }),
    medico.outcome,
  );
  m.post(
    '/pacientes/:id/consentimiento',
    validate(schemas.consentSchema, { back: (req) => `/medico/pacientes/${req.params.id}#consentimiento` }),
    medico.signConsent,
  );
  m.post(
    '/pacientes/:id/consentimiento/revocar',
    validate(schemas.revokeConsentSchema, { back: (req) => `/medico/pacientes/${req.params.id}#consentimiento` }),
    medico.revokeConsent,
  );

  m.get('/estudios/nuevo', medico.newStudy);
  m.post(
    '/estudios',
    upload,
    verifyCsrf,
    validate(schemas.studySchema, {
      back: (req) =>
        `/medico/estudios/nuevo${req.body?.patientId ? `?paciente=${encodeURIComponent(req.body.patientId)}` : ''}`,
    }),
    medico.createStudy,
  );
  m.post(
    '/estudios/vista-previa',
    multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: config.uploads.maxFileMb * 1024 * 1024, files: 1 },
    }).single('archivo'),
    verifyCsrf,
    medico.previewUpload,
  );
  m.get('/estudios/:id', medico.studyDetail);
  m.get('/estudios/:id/informe', medico.report);
  m.post('/estudios/:id/notas', validate(schemas.notesSchema), medico.saveNotes);
  m.post('/estudios/:id/publicacion', validate(schemas.publishSchema), medico.publish);
  m.post(
    '/estudios/:id/control',
    validate(schemas.appointmentSchema, { back: (req) => `/medico/estudios/${req.params.id}#control` }),
    medico.scheduleFromStudy,
  );
  m.get('/controles', medico.appointments);
  m.get('/controles/exportar.csv', medico.exportControles);
  m.post('/controles/:id/estado', validate(schemas.appointmentStatusSchema), medico.setAppointmentStatus);
  router.use('/medico', m);

  /* ---------- Paciente ---------- */
  const p = express.Router();
  p.use(requireAuth, requireRole(ROLES.PACIENTE));
  p.get('/', paciente.home);
  p.get('/estudios', paciente.studies);
  p.get('/estudios/:id', paciente.studyDetail);
  p.get('/controles', paciente.controles);
  p.get('/autocuidado', paciente.selfCare);
  p.get('/datos', paciente.myData);
  router.use('/paciente', p);

  /* ---------- Imágenes (con control de acceso) ---------- */
  router.get('/media/estudios/:studyId/:slot', requireAuth, media.studyImage);

  return router;
}

module.exports = buildRoutes;
