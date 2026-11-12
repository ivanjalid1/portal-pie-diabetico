'use strict';

/**
 * Contratos (interfaces) del patrón Repository.
 *
 * JavaScript no tiene interfaces nativas: cada contrato es una clase base cuyos
 * métodos lanzan `NotImplemented`. Las implementaciones concretas viven en
 * `repositories/memory` y `repositories/supabase`, y la `RepositoryFactory`
 * decide cuál instanciar según `DATA_DRIVER`. Los servicios dependen sólo de
 * estos contratos (Principio de Inversión de Dependencias).
 *
 * Todos los métodos son asíncronos y devuelven entidades de `src/models`.
 */

function notImplemented(name) {
  throw new Error(`${name} no implementado por este driver`);
}

class UserRepository {
  async findById(_id) {
    notImplemented('UserRepository.findById');
  }
  async findByEmail(_email) {
    notImplemented('UserRepository.findByEmail');
  }
  async findByIds(_ids) {
    notImplemented('UserRepository.findByIds');
  }
  /** @param {{role?: string}} _filter */
  async list(_filter) {
    notImplemented('UserRepository.list');
  }
  /** Crea el perfil; el `id` lo provee el AuthProvider al crear la identidad. */
  async create(_user) {
    notImplemented('UserRepository.create');
  }
  async update(_id, _patch) {
    notImplemented('UserRepository.update');
  }
  async countByRole() {
    notImplemented('UserRepository.countByRole');
  }
}

class PatientRepository {
  async findById(_id) {
    notImplemented('PatientRepository.findById');
  }
  async findByUserId(_userId) {
    notImplemented('PatientRepository.findByUserId');
  }
  async findByDni(_dni) {
    notImplemented('PatientRepository.findByDni');
  }
  async findByCodigo(_codigo) {
    notImplemented('PatientRepository.findByCodigo');
  }
  /** Listado de pacientes del médico (sin datos personales: la búsqueda por nombre se resuelve en el servicio). */
  async listByMedico(_medicoId) {
    notImplemented('PatientRepository.listByMedico');
  }
  async listCodigos() {
    notImplemented('PatientRepository.listCodigos');
  }
  async listAll() {
    notImplemented('PatientRepository.listAll');
  }
  async create(_patient) {
    notImplemented('PatientRepository.create');
  }
  async update(_id, _patch) {
    notImplemented('PatientRepository.update');
  }
  async count() {
    notImplemented('PatientRepository.count');
  }
}

class StudyRepository {
  async findById(_id) {
    notImplemented('StudyRepository.findById');
  }
  async listByPatient(_patientId) {
    notImplemented('StudyRepository.listByPatient');
  }
  async listByMedico(_medicoId) {
    notImplemented('StudyRepository.listByMedico');
  }
  async create(_study) {
    notImplemented('StudyRepository.create');
  }
  async update(_id, _patch) {
    notImplemented('StudyRepository.update');
  }
  async count() {
    notImplemented('StudyRepository.count');
  }
  async listAll() {
    notImplemented('StudyRepository.listAll');
  }
}

class AnalysisRepository {
  async findByStudyId(_studyId) {
    notImplemented('AnalysisRepository.findByStudyId');
  }
  async listByStudyIds(_studyIds) {
    notImplemented('AnalysisRepository.listByStudyIds');
  }
  async create(_result) {
    notImplemented('AnalysisRepository.create');
  }
  async count() {
    notImplemented('AnalysisRepository.count');
  }
  async listAll() {
    notImplemented('AnalysisRepository.listAll');
  }
}

class AppointmentRepository {
  async findById(_id) {
    notImplemented('AppointmentRepository.findById');
  }
  async listByPatient(_patientId) {
    notImplemented('AppointmentRepository.listByPatient');
  }
  async listByMedico(_medicoId) {
    notImplemented('AppointmentRepository.listByMedico');
  }
  async create(_appointment) {
    notImplemented('AppointmentRepository.create');
  }
  async update(_id, _patch) {
    notImplemented('AppointmentRepository.update');
  }
}

class AuditRepository {
  async create(_entry) {
    notImplemented('AuditRepository.create');
  }
  /** @param {{limit?: number, action?: string, q?: string}} _filter */
  async list(_filter) {
    notImplemented('AuditRepository.list');
  }
  async count() {
    notImplemented('AuditRepository.count');
  }
}

class ConsentRepository {
  async listByPatient(_patientId) {
    notImplemented('ConsentRepository.listByPatient');
  }
  async create(_consent) {
    notImplemented('ConsentRepository.create');
  }
  async update(_id, _patch) {
    notImplemented('ConsentRepository.update');
  }
}

/** Almacenamiento de archivos (imágenes de estudios). */
class FileStorage {
  /** @returns {Promise<{storagePath: string}>} */
  async save(_input) {
    notImplemented('FileStorage.save');
  }
  /**
   * Devuelve cómo servir el archivo: `{type:'buffer', buffer, mime}` o
   * `{type:'redirect', url}` (URL firmada de corta duración).
   */
  /** Contenido binario del archivo (para vistas previas y análisis). */
  async read(_storagePath) {
    notImplemented('FileStorage.read');
  }

  async getAccess(_storagePath) {
    notImplemented('FileStorage.getAccess');
  }
}

module.exports = {
  UserRepository,
  PatientRepository,
  StudyRepository,
  AnalysisRepository,
  AppointmentRepository,
  AuditRepository,
  ConsentRepository,
  FileStorage,
};
