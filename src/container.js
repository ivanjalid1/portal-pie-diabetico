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
const SettingsService = require('./services/SettingsService');
const OutcomeLog = require('./services/OutcomeLog');
const { MaskService } = require('./services/MaskService');
const { seedDemoData, DEMO_PASSWORD } = require('./seed');
const { loadRealDataset, seedRealData } = require('./seed/realData');

function buildContainer({ config = getConfig(), overrides = {} } = {}) {
  const events = overrides.events || new DomainEventBus();
  const data = overrides.data || createDataLayer(config);
  const { repos, authProvider } = data;
  const predictor =
    overrides.predictor ||
    createPredictor(config.predictor, { realDataDir: config.seed === 'real' ? config.realDataDir : null });

  const auditService = new AuditService({ audit: repos.audit, events }).subscribe();
  const authService = new AuthService({ authProvider, users: repos.users, events });
  const userService = new UserService({ users: repos.users, authProvider, events });
  const settingsService = new SettingsService({ settings: repos.settings, analyses: repos.analyses, events });
  const analysisService = new AnalysisService({
    predictor,
    analyses: repos.analyses,
    events,
    settingsService,
    studies: repos.studies,
    patients: repos.patients,
  });
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

  // Herramienta local de corrección de máscaras (nunca en producción ni en Vercel).
  const maskService = new MaskService({
    dir:
      overrides.maskDir !== undefined
        ? overrides.maskDir
        : config.localTools && !config.isTest
          ? config.localDataDir
          : null,
  });

  // Desenlaces reales registrados en el portal: con el driver memory y datos
  // reales se guardan también en data-local/outcomes/ (persisten al reiniciar y
  // alimentan scripts/ml/train-outcome.py). En pruebas sólo si se pide.
  const outcomeFile =
    overrides.outcomeFile !== undefined
      ? overrides.outcomeFile
      : data.driver === 'memory' && config.seed === 'real' && !config.isTest
        ? require('node:path').join(config.localDataDir, 'outcomes', 'outcomes.json')
        : null;
  const outcomeLog = outcomeFile
    ? new OutcomeLog({ file: outcomeFile, patients: repos.patients, events }).subscribe()
    : null;

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
      settingsService,
      maskService,
    },
    outcomeLog,
    ready: Promise.resolve(),
  };

  // El driver memory arranca vacío: se carga la semilla de demostración.
  // Con SEED=real y la carpeta local data-local/real presente se cargan los
  // pacientes reales precalculados; si falta (CI, Vercel, pruebas), la demo.
  if (data.driver === 'memory' && overrides.seed !== false) {
    const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, config.security.bcryptRounds);
    const dataset = config.seed === 'real' ? loadRealDataset(config.realDataDir) : null;
    if (config.seed === 'real' && !dataset) {
      console.warn(
        '[seed] SEED=real pero no se encontró data-local/real/dataset.json: se usan los datos de demostración.',
      );
    }
    container.seedMode = dataset ? 'real' : 'demo';
    container.ready = dataset
      ? seedRealData(
          { repos, predictor },
          {
            dataset,
            dir: config.realDataDir,
            passwordHash,
            log: config.isTest ? undefined : (m) => console.log(`[seed] ${m}`),
          },
        )
      : seedDemoData({ repos, authProvider, predictor }, { passwordHash });
  }
  if (outcomeLog) container.ready = container.ready.then(() => outcomeLog.applyAll());
  return container;
}

module.exports = { buildContainer };
