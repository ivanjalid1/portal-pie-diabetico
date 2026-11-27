'use strict';

const zlib = require('node:zlib');
const MaskCorrection = require('../models/MaskCorrection');
const { decodeRle, encodeRle } = require('./MaskService');
const { decodeThermal } = require('../imaging/thermalArray');
const { canonicalFeet, qualityScore, encodeGrid, labelsToMasks } = require('../imaging/pointwise');
const { EVENTS } = require('../utils/eventBus');
const { NotFoundError, ValidationError } = require('../utils/errors');

/**
 * Archivo privado de un contorno corregido (bucket `estudios`). La ruta no
 * empieza con el id del paciente: las políticas de Storage del cliente no la
 * alcanzan y sólo la lee el servidor.
 */
const MASK_PATH = (study, toma, rep) => `mascaras/${study.patientId}/${study.id}/toma${toma}-r${rep}.json.gz`;
const W = 320;
const H = 240;

/**
 * «Corregir contorno» en «Revisión de fotos»: el revisor (médico/a tratante o
 * administrador/a) corrige con pincel y goma la máscara de los pies de una foto
 * de una toma. Con el contorno corregido se vuelven a calcular las grillas de
 * esa foto desde su matriz de temperaturas (la misma del visor: no se cambia
 * ninguna temperatura) y, si es la foto que usa el análisis, se vuelve a
 * analizar la toma. Los contornos corregidos son además etiquetas verdaderas
 * para reentrenar y evaluar la U-Net (scripts/ml/pull-corrected-masks.js).
 */
class MaskCorrectionService {
  constructor({ corrections, files, users, studyService, viewerService, replicaStore, analysisService, events }) {
    this.corrections = corrections;
    this.files = files;
    this.users = users;
    this.studyService = studyService;
    this.viewerService = viewerService;
    this.replicaStore = replicaStore;
    this.analysisService = analysisService;
    this.events = events;
  }

  /** Nombres (id → nombre completo) de quienes corrigieron. */
  async names(rows) {
    const ids = [...new Set(rows.map((r) => r.corregidoPor).filter(Boolean))];
    return new Map((ids.length ? await this.users.findByIds(ids) : []).map((u) => [u.id, u.nombreCompleto]));
  }

  /** Contornos corregidos de varios estudios: `${studyId}:${toma}:${rep}` → { por, at }. */
  async byStudies(studyIds) {
    const rows = studyIds.length ? await this.corrections.listByStudyIds(studyIds) : [];
    const names = await this.names(rows);
    return new Map(
      rows.map((r) => [
        `${r.studyId}:${r.toma}:${r.replica}`,
        { por: names.get(r.corregidoPor) || 'un usuario', at: r.corregidoAt },
      ]),
    );
  }

  async #row(studyId, toma, rep) {
    return (
      (await this.corrections.listByStudy(studyId)).find((r) => r.toma === Number(toma) && r.replica === Number(rep)) ||
      null
    );
  }

  async #file(row) {
    if (!row?.storagePath) return null;
    try {
      const gz = await this.files.read(row.storagePath);
      return gz ? JSON.parse(zlib.gunzipSync(gz).toString('utf8')) : null;
    } catch {
      return null;
    }
  }

  /**
   * Datos de análisis de una foto con su contorno vigente: el corregido a mano
   * (grillas recalculadas, TCI a recalcular) o el automático (ReplicaStore).
   */
  async entry(study, patient, toma, rep) {
    const base = this.replicaStore ? await this.replicaStore.replica(study, patient, toma, rep) : null;
    if (!base) return null;
    const row = await this.#row(study.id, toma, rep);
    const f = row ? await this.#file(row) : null;
    if (!f?.izq || !f?.der) return base;
    const por = row.corregidoPor ? (await this.names([row])).get(row.corregidoPor) || 'un usuario' : 'un usuario';
    return {
      ...base,
      izq: f.izq,
      der: f.der,
      calidad: f.calidad ?? base.calidad,
      marco: f.marco ?? base.marco,
      segmentacion: 'manual',
      tci: null,
      contorno: { por, at: row.corregidoAt },
    };
  }

  /** Contornos para el editor: el automático, el corregido (si hay) y quién lo corrigió. */
  async editor(studyId, toma, rep, user) {
    const { study, patient } = await this.studyService.getForReviewer(studyId, user);
    const base = this.replicaStore ? await this.replicaStore.replica(study, patient, toma, rep) : null;
    if (!base) throw new NotFoundError('Esta foto no tiene contorno para corregir.');
    const row = await this.#row(study.id, toma, rep);
    const f = row ? await this.#file(row) : null;
    const por = row?.corregidoPor ? (await this.names([row])).get(row.corregidoPor) || 'un usuario' : null;
    const a = this.analysisService ? await this.analysisService.forStudy(study.id) : null;
    const usada = a?.puntual?.tomas?.find((t) => t.toma === Number(toma))?.calidadFotos?.rep ?? null;
    return {
      study,
      patient,
      toma: Number(toma),
      rep: Number(rep),
      width: W,
      height: H,
      automatica: base.mascara,
      corregida: f?.rle || null,
      base: f?.rle ? 'corregida' : 'automatica',
      corregidoPor: por,
      corregidoAt: row?.corregidoAt || null,
      usada: usada === Number(rep),
    };
  }

  /** Vuelve a analizar la toma si usa esta foto (conserva quién eligió la foto). */
  async #rerunSiUsada(study, patient, toma, rep, actor) {
    const a = this.analysisService ? await this.analysisService.forStudy(study.id) : null;
    const t = a?.puntual?.tomas?.find((x) => x.toma === Number(toma));
    if (!t || (t.calidadFotos?.rep ?? null) !== Number(rep)) return null;
    const entry = await this.entry(study, patient, toma, rep);
    if (!entry) return null;
    return this.analysisService.rerunToma(
      { study, patient, toma: Number(toma), replica: entry, revisor: t.calidadFotos?.elegidaPor || null },
      actor,
    );
  }

  /**
   * Guarda el contorno corregido (RLE) de una foto: recalcula sus grillas
   * desde la matriz de temperaturas con esa máscara (sin limpiezas
   * automáticas) y, si es la foto usada, vuelve a analizar la toma.
   */
  async save(studyId, toma, rep, { rle, origen = null }, actor) {
    const { study, patient } = await this.studyService.getForReviewer(studyId, actor);
    const base = this.replicaStore ? await this.replicaStore.replica(study, patient, toma, rep) : null;
    if (!base) throw new NotFoundError('Esta foto no tiene contorno para corregir.');
    let labels;
    try {
      labels = decodeRle(rle);
    } catch {
      throw new ValidationError('El contorno no es válido.');
    }
    const pix = [0, 0, 0];
    for (const v of labels) pix[v] += 1;
    if (pix[1] < MaskCorrection.PIXELES_MINIMOS || pix[2] < MaskCorrection.PIXELES_MINIMOS) {
      throw new ValidationError(`Cada pie debe tener al menos ${MaskCorrection.PIXELES_MINIMOS} píxeles marcados.`);
    }
    const img = decodeThermal(await this.viewerService.thermal(study, patient, toma, rep));
    if (img.width !== W || img.height !== H) throw new ValidationError('Tamaño de imagen no soportado.');
    const cf = canonicalFeet(img, { celsius: img.data, masks: labelsToMasks(labels), masksSource: 'manual' });
    if (!cf.ok) throw new ValidationError('Con este contorno no se pueden registrar los pies.');
    const storagePath = MASK_PATH(study, toma, rep);
    const payload = {
      version: 1,
      clave: base.clave,
      origen: ['automatica', 'corregida'].includes(origen) ? origen : null,
      rle: encodeRle(labels),
      izq: encodeGrid(cf.izq),
      der: encodeGrid(cf.der),
      calidad: qualityScore(cf),
      marco: cf.marco,
    };
    await this.files.put({
      key: storagePath,
      buffer: zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }),
      mime: 'application/octet-stream',
    });
    const correction = await this.corrections.upsert({
      studyId: study.id,
      toma: Number(toma),
      replica: Number(rep),
      storagePath,
      clave: /^[0-9a-f]{16}$/.test(String(base.clave)) ? base.clave : null,
      pixeles: { fondo: pix[0], pieIzquierdoImagen: pix[1], pieDerechoImagen: pix[2] },
      corregidoPor: actor.id,
      corregidoAt: new Date().toISOString(),
    });
    const analisis = await this.#rerunSiUsada(study, patient, toma, rep, actor);
    this.events.publish(EVENTS.MASK_CORRECTED, {
      actor,
      entity: 'estudio',
      entityId: study.id,
      detail: `${patient.codigo} · toma ${toma}, foto ${rep}: contorno corregido${analisis ? ' (análisis recalculado)' : ''}`,
    });
    return { correction, analisis };
  }

  /** Quita el contorno corregido: la foto vuelve al automático (y la toma, si la usa, se vuelve a analizar). */
  async reset(studyId, toma, rep, actor) {
    const { study, patient } = await this.studyService.getForReviewer(studyId, actor);
    const row = await this.#row(study.id, toma, rep);
    if (!row) return { analisis: null };
    await this.corrections.remove(study.id, Number(toma), Number(rep));
    if (row.storagePath) await this.files.remove(row.storagePath).catch(() => null);
    const analisis = await this.#rerunSiUsada(study, patient, toma, rep, actor);
    this.events.publish(EVENTS.MASK_CORRECTED, {
      actor,
      entity: 'estudio',
      entityId: study.id,
      detail: `${patient.codigo} · toma ${toma}, foto ${rep}: vuelve al contorno automático`,
    });
    return { analisis };
  }
}

module.exports = { MaskCorrectionService, MASK_PATH };
