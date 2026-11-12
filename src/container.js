'use strict';

/**
 * Raíz de composición (inyección de dependencias).
 *
 * Es el ÚNICO lugar donde se instancian clases concretas y se cablean entre sí:
 * configuración → capa de datos (Factory) → estrategia de predicción →
 * servicios → observadores. Los controladores reciben los servicios ya armados.
 * En los tests se puede reemplazar cualquier pieza mediante `overrides`.
 */
const bcrypt = require('bcryptjs');
const { getConfig } = require('./config');
const { createDataLayer } = require('./repositories/RepositoryFactory');
const { createPredictor } = require('./services/predictors/PredictorFactory');
const { DomainEventBus } = require('./utils/eventBus');
const AuditService = require('./services/AuditService');
const AuthService = require('./services/AuthService');
const UserService = require('./services/UserService');
const PatientService = require('./services/PatientService');
const AnalysisService = require('./services/AnalysisService');
const AppointmentService = require('./services/AppointmentService');
const StudyService = require('./services/StudyService');
const DashboardService = require('./services/DashboardService');
const { seedDemoData, DEMO_PASSWORD } = require('./seed');

function buildContainer({ config = getConfig(), overrides = {} } = {}) {
  const events = overrides.events || new DomainEventBus();
  const data = overrides.data || createDataLayer(config);
  const { repos, authProvider } = data;
  const predictor = overrides.predictor || createPredictor(config.predictor);

  const auditService = new AuditService({ audit: repos.audit, events }).subscribe();
  const authService = new AuthService({ authProvider, users: repos.users, events });
  const userService = new UserService({ users: repos.users, authProvider, events });
  const analysisService = new AnalysisService({ predictor, analyses: repos.analyses, events });
  const patientService = new PatientService({
    patients: repos.patients,
    users: repos.users,
    studies: repos.studies,
    analyses: repos.analyses,
    appointments: repos.appointments,
    consents: repos.consents,
    userService,
    events,
  });
  const appointmentService = new AppointmentService({
    appointments: repos.appointments,
    studies: repos.studies,
    analyses: repos.analyses,
    patientService,
    events,
  });
  const studyService = new StudyService({
    studies: repos.studies,
    patients: repos.patients,
    patientService,
    files: repos.files,
    analysisService,
    appointmentService,
    events,
    maxUploadBytes: config.uploads.maxFileMb * 1024 * 1024,
  });
  const dashboardService = new DashboardService({
    patients: repos.patients,
    studies: repos.studies,
    analyses: repos.analyses,
    appointments: repos.appointments,
    users: repos.users,
    audit: repos.audit,
    analysisService,
    config,
  });

  const container = {
    config,
    events,
    driver: data.driver,
    repos,
    authProvider,
    predictor,
    services: {
      auditService,
      authService,
      userService,
      analysisService,
      appointmentService,
      patientService,
      studyService,
      dashboardService,
    },
    ready: Promise.resolve(),
  };

  // El driver memory arranca vacío: se carga la semilla de demostración.
  if (data.driver === 'memory' && overrides.seed !== false) {
    const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, config.security.bcryptRounds);
    container.ready = seedDemoData({ repos, authProvider, predictor }, { passwordHash });
  }
  return container;
}

module.exports = { buildContainer };
