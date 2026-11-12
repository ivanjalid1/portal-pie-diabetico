'use strict';

/**
 * Driver `supabase`: implementación de los contratos de repositorio sobre
 * Postgres (PostgREST) con @supabase/supabase-js v2, y del FileStorage sobre
 * Supabase Storage (bucket privado `estudios`, acceso con URLs firmadas).
 *
 * El cliente usa la service-role key (sólo servidor), por lo que RLS no se
 * aplica a estas consultas: las políticas de `supabase/migrations` son una
 * defensa en profundidad para cualquier acceso directo con la anon key.
 */
const contracts = require('../contracts');
const { User, Patient, Study, AnalysisResult, Appointment, AuditEntry, Consent } = require('../../models');
const { toRow, fromRow } = require('./mappers');

/** Lanza un error legible si la respuesta de PostgREST trae error. */
function check({ data, error, count }, context) {
  if (error) {
    const err = new Error(`[supabase] ${context}: ${error.message}`);
    err.cause = error;
    err.code = error.code;
    throw err;
  }
  return count !== undefined && count !== null && data === null ? count : data;
}

const uniqueViolation = (err) => err?.code === '23505';

class SupabaseBase {
  constructor(db, table, Entity) {
    this.db = db;
    this.table = table;
    this.Entity = Entity;
  }

  entity(row) {
    return row ? new this.Entity(fromRow(this.table, row)) : null;
  }

  async findOneBy(column, value, select = '*') {
    const data = check(await this.db.from(this.table).select(select).eq(column, value).maybeSingle(), `${this.table}.findOneBy`);
    return this.entity(data);
  }

  async insertRow(obj) {
    const data = check(await this.db.from(this.table).insert(toRow(this.table, obj)).select().single(), `${this.table}.insert`);
    return this.entity(data);
  }

  async updateRow(id, patch) {
    const { id: _id, ...rest } = patch;
    const row = toRow(this.table, rest);
    if (!Object.keys(row).length) return this.findById(id);
    const data = check(
      await this.db.from(this.table).update(row).eq('id', id).select().maybeSingle(),
      `${this.table}.update`,
    );
    return this.entity(data);
  }

  async countAll() {
    return check(await this.db.from(this.table).select('*', { count: 'exact', head: true }), `${this.table}.count`) || 0;
  }

  async findById(id) {
    return this.findOneBy('id', id);
  }
}

/* ---------- Usuarios (perfiles) ---------- */
class SupabaseUserRepository extends contracts.UserRepository {
  constructor(db) {
    super();
    this.b = new SupabaseBase(db, 'profiles', User);
  }
  async findById(id) {
    return this.b.findById(id);
  }
  async findByEmail(email) {
    return this.b.findOneBy('email', String(email).toLowerCase());
  }
  async findByIds(ids) {
    if (!ids.length) return [];
    const data = check(await this.b.db.from('profiles').select('*').in('id', ids), 'profiles.findByIds');
    return data.map((r) => this.b.entity(r));
  }
  async list(filter = {}) {
    let q = this.b.db.from('profiles').select('*').order('apellido', { ascending: true });
    if (filter.role) q = q.eq('role', filter.role);
    return check(await q, 'profiles.list').map((r) => this.b.entity(r));
  }
  async create(user) {
    return this.b.insertRow({ ...user, email: String(user.email).toLowerCase() });
  }
  async update(id, patch) {
    return this.b.updateRow(id, patch);
  }
  async countByRole() {
    const data = check(await this.b.db.from('profiles').select('role'), 'profiles.countByRole');
    const out = { admin: 0, medico: 0, paciente: 0 };
    for (const r of data) out[r.role] = (out[r.role] || 0) + 1;
    return out;
  }
}

/* ---------- Pacientes (ficha clínica) ---------- */
class SupabasePatientRepository extends contracts.PatientRepository {
  constructor(db) {
    super();
    this.b = new SupabaseBase(db, 'patients', Patient);
  }
  async findById(id) {
    return this.b.findById(id);
  }
  async findByUserId(userId) {
    return this.b.findOneBy('user_id', userId);
  }
  async findByDni(dni) {
    return dni ? this.b.findOneBy('dni', String(dni)) : null;
  }
  async findByCodigo(codigo) {
    return this.b.findOneBy('codigo', codigo);
  }
  async listByMedico(medicoId) {
    const data = check(
      await this.b.db.from('patients').select('*').eq('medico_id', medicoId).order('codigo'),
      'patients.listByMedico',
    );
    return data.map((r) => this.b.entity(r));
  }
  async listCodigos() {
    return check(await this.b.db.from('patients').select('codigo'), 'patients.listCodigos').map((r) => r.codigo);
  }
  async listAll() {
    return check(await this.b.db.from('patients').select('*'), 'patients.listAll').map((r) => this.b.entity(r));
  }
  async create(patient) {
    try {
      return await this.b.insertRow(patient);
    } catch (err) {
      if (uniqueViolation(err)) {
        const { ConflictError } = require('../../utils/errors');
        throw new ConflictError('Ya existe un paciente con ese código o DNI.');
      }
      throw err;
    }
  }
  async update(id, patch) {
    return this.b.updateRow(id, patch);
  }
  async count() {
    return this.b.countAll();
  }
}

/* ---------- Estudios + imágenes ---------- */
const STUDY_SELECT = '*, study_images(*)';

class SupabaseStudyRepository extends contracts.StudyRepository {
  constructor(db) {
    super();
    this.b = new SupabaseBase(db, 'studies', Study);
  }
  entity(row) {
    if (!row) return null;
    const images = (row.study_images || []).map((i) => fromRow('study_images', i));
    return new Study({ ...fromRow('studies', row), images });
  }
  async findById(id) {
    const data = check(
      await this.b.db.from('studies').select(STUDY_SELECT).eq('id', id).maybeSingle(),
      'studies.findById',
    );
    return this.entity(data);
  }
  async listBy(column, value) {
    let q = this.b.db.from('studies').select(STUDY_SELECT).order('fecha_hora', { ascending: false });
    if (column) q = q.eq(column, value);
    return check(await q, 'studies.list').map((r) => this.entity(r));
  }
  async listByPatient(patientId) {
    return this.listBy('patient_id', patientId);
  }
  async listByMedico(medicoId) {
    return this.listBy('medico_id', medicoId);
  }
  async listAll() {
    return this.listBy(null);
  }
  async create(study) {
    const row = check(
      await this.b.db.from('studies').insert(toRow('studies', study)).select().single(),
      'studies.insert',
    );
    const images = (study.images || []).map((img) => toRow('study_images', { ...img, studyId: row.id }));
    if (images.length) {
      const res = await this.b.db.from('study_images').insert(images);
      if (res.error) {
        // Compensación: no dejar un estudio sin imágenes.
        await this.b.db.from('studies').delete().eq('id', row.id);
        check(res, 'study_images.insert');
      }
    }
    return this.findById(row.id);
  }
  async update(id, patch) {
    const { images: _images, ...rest } = patch;
    const row = toRow('studies', rest);
    if (Object.keys(row).length) {
      check(await this.b.db.from('studies').update(row).eq('id', id), 'studies.update');
    }
    return this.findById(id);
  }
  async count() {
    return this.b.countAll();
  }
}

/* ---------- Resultados de análisis + mediciones por ROI ---------- */
const ANALYSIS_SELECT = '*, roi_mediciones(*)';

class SupabaseAnalysisRepository extends contracts.AnalysisRepository {
  constructor(db) {
    super();
    this.db = db;
  }
  entity(row) {
    if (!row) return null;
    const all = (row.roi_mediciones || []).map((r) => fromRow('roi_mediciones', r));
    const rois = all.filter((r) => Number(r.toma ?? 2) === 2);
    const roisToma1 = all.filter((r) => Number(r.toma) === 1);
    return new AnalysisResult({ ...fromRow('analysis_results', row), rois, roisToma1 });
  }
  async findByStudyId(studyId) {
    const data = check(
      await this.db
        .from('analysis_results')
        .select(ANALYSIS_SELECT)
        .eq('study_id', studyId)
        .order('created_at', { ascending: false })
        .limit(1),
      'analysis_results.findByStudyId',
    );
    return this.entity(data[0]);
  }
  async listByStudyIds(studyIds) {
    if (!studyIds.length) return [];
    const data = check(
      await this.db
        .from('analysis_results')
        .select(ANALYSIS_SELECT)
        .in('study_id', studyIds)
        .order('created_at', { ascending: false }),
      'analysis_results.listByStudyIds',
    );
    // Un resultado (el más reciente) por estudio.
    const seen = new Set();
    return data.filter((r) => !seen.has(r.study_id) && seen.add(r.study_id)).map((r) => this.entity(r));
  }
  async listAll() {
    const data = check(await this.db.from('analysis_results').select(ANALYSIS_SELECT), 'analysis_results.listAll');
    return data.map((r) => this.entity(r));
  }
  async create(result) {
    const row = check(
      await this.db.from('analysis_results').insert(toRow('analysis_results', result)).select().single(),
      'analysis_results.insert',
    );
    const rois = [
      ...(result.roisToma1 || []).map((r) => toRow('roi_mediciones', { ...r, toma: 1, analysisId: row.id })),
      ...(result.rois || []).map((r) => toRow('roi_mediciones', { ...r, toma: 2, analysisId: row.id })),
    ];
    if (rois.length) check(await this.db.from('roi_mediciones').insert(rois), 'roi_mediciones.insert');
    return this.findByStudyId(row.study_id);
  }
  async count() {
    return check(await this.db.from('analysis_results').select('*', { count: 'exact', head: true }), 'analysis.count') || 0;
  }
}

/* ---------- Controles ---------- */
class SupabaseAppointmentRepository extends contracts.AppointmentRepository {
  constructor(db) {
    super();
    this.b = new SupabaseBase(db, 'appointments', Appointment);
  }
  async findById(id) {
    return this.b.findById(id);
  }
  async listBy(column, value) {
    const data = check(
      await this.b.db.from('appointments').select('*').eq(column, value).order('fecha', { ascending: true }),
      'appointments.list',
    );
    return data.map((r) => this.b.entity(r));
  }
  async listByPatient(patientId) {
    return this.listBy('patient_id', patientId);
  }
  async listByMedico(medicoId) {
    return this.listBy('medico_id', medicoId);
  }
  async create(appointment) {
    return this.b.insertRow(appointment);
  }
  async update(id, patch) {
    return this.b.updateRow(id, patch);
  }
}

/* ---------- Consentimientos ---------- */
class SupabaseConsentRepository extends contracts.ConsentRepository {
  constructor(db) {
    super();
    this.b = new SupabaseBase(db, 'consents', Consent);
  }
  async listByPatient(patientId) {
    const data = check(
      await this.b.db.from('consents').select('*').eq('patient_id', patientId).order('created_at', { ascending: false }),
      'consents.list',
    );
    return data.map((r) => this.b.entity(r));
  }
  async create(consent) {
    return this.b.insertRow(consent);
  }
  async update(id, patch) {
    return this.b.updateRow(id, patch);
  }
}

/* ---------- Auditoría ---------- */
class SupabaseAuditRepository extends contracts.AuditRepository {
  constructor(db) {
    super();
    this.b = new SupabaseBase(db, 'audit_log', AuditEntry);
  }
  async create(entry) {
    return this.b.insertRow(entry);
  }
  async list(filter = {}) {
    let q = this.b.db
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(filter.limit || 200);
    if (filter.action) q = q.eq('action', filter.action);
    if (filter.q) {
      // Se quitan los caracteres con significado en la sintaxis de filtros de PostgREST.
      const term = String(filter.q).replace(/[,()*%\\]/g, ' ').trim();
      if (term) q = q.or(`actor_email.ilike.%${term}%,detail.ilike.%${term}%,action.ilike.%${term}%`);
    }
    return check(await q, 'audit_log.list').map((r) => this.b.entity(r));
  }
  async count() {
    return this.b.countAll();
  }
}

/* ---------- Almacenamiento de imágenes ---------- */
class SupabaseFileStorage extends contracts.FileStorage {
  constructor(db, { bucket, signedUrlTtlSeconds }) {
    super();
    this.db = db;
    this.bucket = bucket;
    this.ttl = signedUrlTtlSeconds;
  }
  async save({ key, buffer, mime }) {
    const { data, error } = await this.db.storage.from(this.bucket).upload(key, buffer, {
      contentType: mime,
      upsert: false,
    });
    if (error) throw new Error(`[supabase] storage.upload: ${error.message}`);
    return { storagePath: data.path };
  }
  async read(storagePath) {
    const { data, error } = await this.db.storage.from(this.bucket).download(storagePath);
    if (error) return null;
    return Buffer.from(await data.arrayBuffer());
  }
  async getAccess(storagePath, { download } = {}) {
    const { data, error } = await this.db.storage
      .from(this.bucket)
      .createSignedUrl(storagePath, this.ttl, download && /\.(is2|tiff?)$/i.test(download) ? { download } : undefined);
    if (error) return null;
    return { type: 'redirect', url: data.signedUrl };
  }
}

function createSupabaseRepositories(db, config) {
  return {
    users: new SupabaseUserRepository(db),
    patients: new SupabasePatientRepository(db),
    studies: new SupabaseStudyRepository(db),
    analyses: new SupabaseAnalysisRepository(db),
    appointments: new SupabaseAppointmentRepository(db),
    consents: new SupabaseConsentRepository(db),
    audit: new SupabaseAuditRepository(db),
    files: new SupabaseFileStorage(db, config.supabase),
  };
}

module.exports = {
  createSupabaseRepositories,
  SupabaseUserRepository,
  SupabasePatientRepository,
  SupabaseStudyRepository,
  SupabaseAnalysisRepository,
  SupabaseAppointmentRepository,
  SupabaseConsentRepository,
  SupabaseAuditRepository,
  SupabaseFileStorage,
};
