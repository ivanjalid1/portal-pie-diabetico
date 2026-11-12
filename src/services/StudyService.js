'use strict';

const { ROLES } = require('../models/roles');
const { ForbiddenError, NotFoundError, ValidationError } = require('../utils/errors');
const { EVENTS } = require('../utils/eventBus');
const { uuid } = require('../utils/random');
const { validateStudyImages } = require('../validators/imageValidator');
const { is2PreviewPng } = require('../imaging/thermogram');

/**
 * Casos de uso de estudios termográficos: alta con imágenes + análisis,
 * notas, publicación al paciente y acceso controlado a las imágenes.
 */
class StudyService {
  constructor({
    studies,
    patients,
    patientService,
    files,
    analysisService,
    appointmentService,
    events,
    maxUploadBytes,
  }) {
    this.studies = studies;
    this.patients = patients;
    this.patientService = patientService;
    this.files = files;
    this.analysisService = analysisService;
    this.appointmentService = appointmentService;
    this.events = events;
    this.maxUploadBytes = maxUploadBytes;
  }

  /**
   * Flujo principal del asistente: crea el estudio, guarda las 2 imágenes,
   * ejecuta la estrategia de predicción y devuelve el estudio con su resultado.
   */
  async createWithAnalysis({ patientId, acquisition, filesBySlot }, actor) {
    const patient = await this.patientService.getForMedico(patientId, actor.id);
    if (!patient.consentimientoFirmado) {
      throw new ValidationError('El paciente no tiene un consentimiento informado vigente.');
    }

    // Toma 1: se sube o se reutiliza la de un estudio anterior del mismo paciente.
    const { toma1Origen, ...rest } = acquisition;
    let reused = null;
    if (toma1Origen) {
      const origin = await this.studies.findById(toma1Origen);
      if (!origin || origin.patientId !== patient.id || origin.medicoId !== actor.id || !origin.image('toma1')) {
        throw new ValidationError('La toma 1 elegida no pertenece a este paciente.', {
          toma1Origen: 'Elegí otra toma.',
        });
      }
      reused = origin;
    }

    const slots = reused ? ['toma2'] : ['toma1', 'toma2'];
    const { ok, errors, images } = validateStudyImages(filesBySlot, this.maxUploadBytes, slots);
    if (!ok) throw new ValidationError(Object.values(errors)[0] || 'Revisá las imágenes cargadas.', errors);

    const studyId = uuid();
    const stored = [];
    if (reused) {
      const img = reused.image('toma1');
      // Se reutiliza el mismo archivo, pero como imagen nueva de este estudio.
      const { id: _id, studyId: _sid, ...ref } = img;
      stored.push(ref);
      const buffer = img.storagePath ? await this.files.read(img.storagePath) : null;
      images.unshift({ slot: 'toma1', buffer, mime: img.mime, originalName: img.originalName, reused: true });
    }
    for (const img of images.filter((i) => !i.reused)) {
      const key = `${patient.id}/${studyId}/${img.slot}.${img.ext}`;
      const { storagePath } = await this.files.save({ key, buffer: img.buffer, mime: img.mime });
      stored.push({ slot: img.slot, storagePath, mime: img.mime, size: img.size, originalName: img.originalName });
    }

    let study = await this.studies.create({
      ...rest,
      ...(reused
        ? {
            fechaToma1: reused.fechaToma1,
            tempAmbienteToma1: reused.tempAmbienteToma1,
            humedadRelativaToma1: reused.humedadRelativaToma1,
            toma1OrigenStudyId: reused.id,
          }
        : { fechaToma1: rest.fechaToma1 ? new Date(`${rest.fechaToma1}T12:00:00-03:00`).toISOString() : null }),
      id: studyId,
      patientId: patient.id,
      medicoId: actor.id,
      images: stored,
      estado: 'borrador',
    });
    this.events.publish(EVENTS.STUDY_CREATED, {
      actor,
      entity: 'estudio',
      entityId: study.id,
      detail: `${patient.codigo}: toma 1 ${reused ? 'reutilizada' : 'nueva'} + toma 2 · HR ${study.humedadRelativa} %`,
    });

    const analysis = await this.analysisService.run({ study, patient, images }, actor);
    study = await this.studies.update(study.id, { estado: 'analizado' });
    // El control pendiente del paciente queda realizado y vinculado a este estudio.
    // Es un efecto secundario: si falla, el estudio ya guardado no se pierde.
    try {
      await this.appointmentService.completeWithStudy(study, actor);
    } catch (err) {
      console.error(`[controles] no se pudo vincular el control al estudio ${study.id}: ${err.message}`);
    }
    return { study, patient, analysis };
  }

  /** Tomas 1 disponibles para reutilizar (estudios previos del paciente). */
  async toma1Options(patientId, medicoId) {
    const list = await this.studies.listByPatient(patientId);
    return list
      .filter((s) => s.medicoId === medicoId && s.image('toma1'))
      .map((s) => ({ studyId: s.id, fecha: s.fechaToma1 || s.fechaHora }));
  }

  /** Detalle para el médico tratante (con verificación de pertenencia). */
  async getForMedico(id, medicoId) {
    const study = await this.studies.findById(id);
    if (!study) throw new NotFoundError('El estudio no existe.');
    if (study.medicoId !== medicoId) throw new ForbiddenError('Este estudio no pertenece a tus pacientes.');
    const [patient, analysis, appointments] = await Promise.all([
      this.patientService.getForMedico(study.patientId, medicoId),
      this.analysisService.forStudy(study.id),
      this.appointmentService.listForPatient(study.patientId),
    ]);
    return { study, patient, analysis, appointments };
  }

  /** Detalle para el paciente: sólo sus estudios; el resultado sólo si fue publicado. */
  async getForPaciente(id, userId) {
    const patient = await this.patientService.getByUserId(userId);
    const study = await this.studies.findById(id);
    if (!study || study.patientId !== patient.id) throw new NotFoundError('El estudio no existe.');
    const analysis = study.publicado ? await this.analysisService.forStudy(study.id) : null;
    return { study, patient, analysis };
  }

  async listForPaciente(userId) {
    const patient = await this.patientService.getByUserId(userId);
    const studies = await this.studies.listByPatient(patient.id);
    const items = [];
    for (const study of studies) {
      items.push({ study, analysis: study.publicado ? await this.analysisService.forStudy(study.id) : null });
    }
    return { patient, items };
  }

  async updateNotes(id, notasMedico, actor) {
    await this.getForMedico(id, actor.id);
    const study = await this.studies.update(id, { notasMedico });
    this.events.publish(EVENTS.STUDY_NOTES_UPDATED, { actor, entity: 'estudio', entityId: id });
    return study;
  }

  async setPublished(id, publicado, actor) {
    const { analysis } = await this.getForMedico(id, actor.id);
    if (publicado && !analysis) throw new ValidationError('El estudio todavía no tiene resultado para publicar.');
    const study = await this.studies.update(id, {
      publicado: Boolean(publicado),
      publicadoAt: publicado ? new Date().toISOString() : null,
    });
    this.events.publish(publicado ? EVENTS.RESULT_PUBLISHED : EVENTS.RESULT_UNPUBLISHED, {
      actor,
      entity: 'estudio',
      entityId: id,
    });
    return study;
  }

  async exportReport(id, actor) {
    const data = await this.getForMedico(id, actor.id);
    this.events.publish(EVENTS.REPORT_EXPORTED, { actor, entity: 'estudio', entityId: id });
    return data;
  }

  /** Autoriza y resuelve el acceso a una imagen de estudio. */
  async getImageAccess(studyId, slot, user, { render = false, palette } = {}) {
    const study = await this.studies.findById(studyId);
    if (!study) throw new NotFoundError('La imagen no existe.');
    if (user.role === ROLES.MEDICO) {
      if (study.medicoId !== user.id) throw new ForbiddenError();
    } else if (user.role === ROLES.PACIENTE) {
      const patient = await this.patients.findByUserId(user.id);
      if (!patient || patient.id !== study.patientId) throw new ForbiddenError();
    } else {
      // El administrador gestiona cuentas pero no accede a datos clínicos.
      throw new ForbiddenError();
    }
    const image = study.image(slot);
    if (!image) throw new NotFoundError('La imagen no existe.');
    if (image.publicUrl) return { type: 'redirect', url: image.publicUrl };
    // Los IS2 no se pueden mostrar en el navegador: se genera un PNG de la matriz IR.
    if (render && image.mime === 'application/x-fluke-is2') {
      const buffer = await this.files.read(image.storagePath);
      if (!buffer) throw new NotFoundError('La imagen no está disponible.');
      return { type: 'buffer', buffer: is2PreviewPng(buffer, { palette }), mime: 'image/png' };
    }
    const access = await this.files.getAccess(image.storagePath, { download: image.originalName });
    if (!access) throw new NotFoundError('La imagen no está disponible.');
    return { ...access, filename: image.originalName, mime: access.mime || image.mime };
  }

  /**
   * Listado de estudios del médico con búsqueda por nombre, apellido o código
   * (los nombres vienen del perfil, vía PatientView: funciona igual en ambos
   * drivers), filtros, orden y paginación.
   */
  async searchForMedico(medicoId, f = {}) {
    const { normalize } = require('../utils/text');
    const [rows, studies] = await Promise.all([
      this.patientService.listForMedico(medicoId),
      this.studies.listByMedico(medicoId),
    ]);
    const byPatient = new Map(rows.map((r) => [r.patient.id, r.patient]));
    const analyses = await this.analysisService.analyses.listByStudyIds(studies.map((st) => st.id));
    const aByStudy = new Map(analyses.map((a) => [a.studyId, a]));
    const q = normalize(f.q);
    let items = studies
      .map((study) => ({ study, patient: byPatient.get(study.patientId), analysis: aByStudy.get(study.id) || null }))
      .filter((i) => i.patient && i.analysis);
    const centros = [...new Set(items.map((i) => i.study.centro).filter(Boolean))].sort();
    items = items.filter(({ study, patient, analysis }) => {
      if (q && !normalize(`${patient.codigo} ${patient.nombre} ${patient.apellido}`).includes(q)) return false;
      if (f.desde && new Date(study.fechaHora) < new Date(`${f.desde}T00:00:00-03:00`)) return false;
      if (f.hasta && new Date(study.fechaHora) > new Date(`${f.hasta}T23:59:59-03:00`)) return false;
      if (f.centro && study.centro !== f.centro) return false;
      if (f.riesgo && analysis.categoria !== f.riesgo) return false;
      if (f.grupo && analysis.grupo !== f.grupo) return false;
      if (f.publicado && (f.publicado === 'si') !== study.publicado) return false;
      if (f.desenlace && (f.desenlace === 'con') !== (patient.generoLesion !== null)) return false;
      return true;
    });
    const keys = {
      fecha: (i) => new Date(i.study.fechaHora).getTime(),
      codigo: (i) => i.patient.codigo,
      probabilidad: (i) => i.analysis.probabilidad,
      dt: (i) => Math.abs(i.analysis.deltaTMax),
    };
    const key = keys[f.orden] || keys.fecha;
    const dir = f.dir === 'asc' ? 1 : -1;
    items.sort((a, b) => (key(a) > key(b) ? dir : key(a) < key(b) ? -dir : 0));
    const total = items.length;
    const size = f.size || 10;
    const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(Math.max(1, f.page || 1), pages);
    return { all: items, items: items.slice((page - 1) * size, page * size), total, page, pages, centros };
  }

  async count() {
    return this.studies.count();
  }
}

module.exports = StudyService;
