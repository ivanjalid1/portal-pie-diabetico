'use strict';

/**
 * Driver `memory`: implementación de los contratos de repositorio sobre
 * estructuras en memoria. Es el driver por defecto y permite desplegar la
 * maqueta en Vercel sin base de datos (los datos vuelven al estado semilla en
 * cada arranque en frío de la función).
 */
const contracts = require('../contracts');
const MemoryCollection = require('./MemoryCollection');
const { User, Patient, Study, AnalysisResult, Appointment, AuditEntry, Consent } = require('../../models');

const { normalize } = require('../../utils/text');

const byDateDesc = (field) => (a, b) => new Date(b[field]) - new Date(a[field]);

class MemoryUserRepository extends contracts.UserRepository {
  constructor() {
    super();
    this.col = new MemoryCollection(User);
  }
  async findById(id) {
    return this.col.get(id);
  }
  async findByEmail(email) {
    const e = String(email).toLowerCase();
    return this.col.find((u) => u.email === e);
  }
  async findByIds(ids) {
    const set = new Set(ids);
    return this.col.where((u) => set.has(u.id));
  }
  async list(filter = {}) {
    return this.col
      .where((u) => !filter.role || u.role === filter.role)
      .sort((a, b) => a.apellido.localeCompare(b.apellido, 'es'));
  }
  async create(user) {
    return this.col.insert(user);
  }
  async update(id, patch) {
    return this.col.patch(id, patch);
  }
  async countByRole() {
    const out = { admin: 0, medico: 0, paciente: 0 };
    for (const u of this.col.all()) out[u.role] = (out[u.role] || 0) + 1;
    return out;
  }
}

class MemoryPatientRepository extends contracts.PatientRepository {
  constructor() {
    super();
    this.col = new MemoryCollection(Patient);
  }
  async findById(id) {
    return this.col.get(id);
  }
  async findByUserId(userId) {
    return this.col.find((p) => p.userId === userId);
  }
  async findByDni(dni) {
    return this.col.find((p) => p.dni === String(dni));
  }
  async findByCodigo(codigo) {
    return this.col.find((p) => p.codigo === codigo);
  }
  async listByMedico(medicoId) {
    return this.col.where((p) => p.medicoId === medicoId).sort((a, b) => a.codigo.localeCompare(b.codigo));
  }
  async listCodigos() {
    return this.col.all().map((p) => p.codigo);
  }
  async listAll() {
    return this.col.all();
  }
  async create(patient) {
    return this.col.insert(patient);
  }
  async update(id, patch) {
    return this.col.patch(id, patch);
  }
  async count() {
    return this.col.size;
  }
}

class MemoryStudyRepository extends contracts.StudyRepository {
  constructor() {
    super();
    this.col = new MemoryCollection(Study);
  }
  async findById(id) {
    return this.col.get(id);
  }
  async listByPatient(patientId) {
    return this.col.where((s) => s.patientId === patientId).sort(byDateDesc('fechaHora'));
  }
  async listByMedico(medicoId) {
    return this.col.where((s) => s.medicoId === medicoId).sort(byDateDesc('fechaHora'));
  }
  async listAll() {
    return this.col.all().sort(byDateDesc('fechaHora'));
  }
  async create(study) {
    return this.col.insert(study);
  }
  async update(id, patch) {
    return this.col.patch(id, patch);
  }
  async count() {
    return this.col.size;
  }
}

class MemoryAnalysisRepository extends contracts.AnalysisRepository {
  constructor() {
    super();
    this.col = new MemoryCollection(AnalysisResult);
  }
  async findByStudyId(studyId) {
    return this.col.where((a) => a.studyId === studyId).sort(byDateDesc('createdAt'))[0] || null;
  }
  async listByStudyIds(studyIds) {
    const ids = new Set(studyIds);
    return this.col.where((a) => ids.has(a.studyId));
  }
  async listAll() {
    return this.col.all();
  }
  async create(result) {
    return this.col.insert(result);
  }
  async count() {
    return this.col.size;
  }
}

class MemoryAppointmentRepository extends contracts.AppointmentRepository {
  constructor() {
    super();
    this.col = new MemoryCollection(Appointment);
  }
  async findById(id) {
    return this.col.get(id);
  }
  async listByPatient(patientId) {
    return this.col.where((a) => a.patientId === patientId).sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  }
  async listByMedico(medicoId) {
    return this.col.where((a) => a.medicoId === medicoId).sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  }
  async create(appointment) {
    return this.col.insert(appointment);
  }
  async update(id, patch) {
    return this.col.patch(id, patch);
  }
}

class MemoryAuditRepository extends contracts.AuditRepository {
  constructor() {
    super();
    this.col = new MemoryCollection(AuditEntry);
  }
  async create(entry) {
    return this.col.insert(entry);
  }
  async list(filter = {}) {
    const q = normalize(filter.q);
    return this.col
      .where((e) => !filter.action || e.action === filter.action)
      .filter((e) => !q || normalize(`${e.actorEmail} ${e.action} ${e.detail} ${e.entity}`).includes(q))
      .sort(byDateDesc('createdAt'))
      .slice(0, filter.limit || 200);
  }
  async count() {
    return this.col.size;
  }
}

class MemoryConsentRepository extends contracts.ConsentRepository {
  constructor() {
    super();
    this.col = new MemoryCollection(Consent);
  }
  async listByPatient(patientId) {
    return this.col.where((c) => c.patientId === patientId).sort(byDateDesc('createdAt'));
  }
  async create(consent) {
    return this.col.insert(consent);
  }
  async update(id, patch) {
    return this.col.patch(id, patch);
  }
}

/** Almacenamiento de imágenes en memoria (no usa disco: apto para serverless). */
class MemoryFileStorage extends contracts.FileStorage {
  constructor() {
    super();
    this.files = new Map();
  }
  async save({ key, buffer, mime }) {
    this.files.set(key, { buffer: Buffer.from(buffer), mime });
    return { storagePath: key };
  }
  async getAccess(storagePath) {
    const f = this.files.get(storagePath);
    if (!f) return null;
    return { type: 'buffer', buffer: f.buffer, mime: f.mime };
  }
}

/** Almacén de credenciales (hash bcrypt) separado de los perfiles. */
class MemoryCredentialStore {
  constructor() {
    this.hashes = new Map();
  }
  set(userId, hash) {
    this.hashes.set(userId, hash);
  }
  get(userId) {
    return this.hashes.get(userId) || null;
  }
  delete(userId) {
    this.hashes.delete(userId);
  }
}

function createMemoryRepositories() {
  return {
    users: new MemoryUserRepository(),
    patients: new MemoryPatientRepository(),
    studies: new MemoryStudyRepository(),
    analyses: new MemoryAnalysisRepository(),
    appointments: new MemoryAppointmentRepository(),
    audit: new MemoryAuditRepository(),
    consents: new MemoryConsentRepository(),
    files: new MemoryFileStorage(),
    credentials: new MemoryCredentialStore(),
  };
}

module.exports = {
  createMemoryRepositories,
  MemoryUserRepository,
  MemoryPatientRepository,
  MemoryStudyRepository,
  MemoryAnalysisRepository,
  MemoryAppointmentRepository,
  MemoryAuditRepository,
  MemoryConsentRepository,
  MemoryFileStorage,
  MemoryCredentialStore,
};
