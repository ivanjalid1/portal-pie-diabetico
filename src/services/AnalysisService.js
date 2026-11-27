'use strict';

const { EVENTS } = require('../utils/eventBus');
const { tomaConReplica } = require('../imaging/replicaChoice');

const dec = (v) => String(v ?? '').replace('.', ',');

/**
 * Orquesta la ejecución de la estrategia de predicción y persiste el resultado.
 * No conoce el algoritmo concreto: lo recibe inyectado (`predictor`).
 */
class AnalysisService {
  constructor({ predictor, analyses, events, settingsService = null, studies = null, patients = null }) {
    this.predictor = predictor;
    this.analyses = analyses;
    this.events = events;
    this.settingsService = settingsService;
    this.studies = studies;
    this.patients = patients;
  }

  async #params() {
    return this.settingsService ? this.settingsService.params() : null;
  }

  get predictorInfo() {
    return this.predictor.info;
  }

  async run({ study, patient, images }, actor) {
    const params = await this.#params();
    const output = await this.predictor.predict({ study, patient, images, params });
    const result = await this.analyses.create({ ...output, studyId: study.id });
    this.events.publish(EVENTS.ANALYSIS_COMPLETED, {
      actor,
      entity: 'estudio',
      entityId: study.id,
      detail: `${patient.codigo}: ${result.probabilidad} % (${result.categoria}) · ${result.predictorVersion}`,
    });
    return result;
  }

  /**
   * Recalcula todos los análisis con la configuración vigente. Conserva las
   * temperaturas por región de cada toma (no se vuelven a procesar las
   * imágenes): sólo cambian la clasificación, la probabilidad y el snapshot.
   */
  async recalculateAll(actor) {
    const params = await this.#params();
    const all = await this.analyses.listAll();
    const latest = new Map();
    for (const a of all) {
      const prev = latest.get(a.studyId);
      if (!prev || new Date(a.createdAt) > new Date(prev.createdAt)) latest.set(a.studyId, a);
    }
    let actualizados = 0;
    let cambiaron = 0;
    for (const a of latest.values()) {
      const study = await this.studies.findById(a.studyId);
      const patient = study && (await this.patients.findById(study.patientId));
      if (!study || !patient || !a.rois.length) continue;
      const out = await this.predictor.predict({
        study,
        patient,
        hints: a.puntual
          ? { puntual: Object.fromEntries(a.puntual.tomas.map((t) => [`toma${t.toma}`, t])) }
          : { toma1: a.roisToma1, toma2: a.rois, fuente: a.fuenteRois },
        params,
      });
      const { rois: _r, roisToma1: _r1, ...fields } = out;
      if (fields.grupo !== a.grupo || fields.categoria !== a.categoria || fields.grupoToma1 !== a.grupoToma1)
        cambiaron += 1;
      await this.analyses.update(a.id, fields);
      actualizados += 1;
    }
    this.events.publish(EVENTS.ANALYSES_RECALCULATED, {
      actor,
      entity: 'configuracion',
      entityId: 'global',
      detail: `${actualizados} estudios recalculados (${cambiaron} cambiaron de clasificación) · umbral ${dec(params?.umbral)} °C, simetría < ${dec(params?.corteSimetria)} °C, cortes ${params?.corteModerado}/${params?.corteAlto} %`,
    });
    return { actualizados, cambiaron };
  }

  /**
   * Vuelve a analizar un estudio con OTRA foto (réplica) en una toma: usa las
   * grillas y el TCI ya precalculados de esa réplica (ReplicaStore); las otras
   * tomas, la fecha y el ambiente quedan como estaban. Recalcula riesgo,
   * asimetría, ROIs de referencia y todo lo que deriva del análisis (pronóstico
   * y alertas se calculan a partir de él).
   * @param {{study, patient, toma:number, replica:object, revisor?:string|null}} args
   * @returns {Promise<{antes: object, despues: object}|null>} null si el estudio no tiene análisis punto a punto
   */
  async rerunToma({ study, patient, toma, replica, revisor = null }, actor) {
    const a = await this.analyses.findByStudyId(study.id);
    const t = a?.puntual?.tomas?.find((x) => x.toma === Number(toma));
    if (!t) return null;
    const params = await this.#params();
    const hints = {
      puntual: Object.fromEntries(
        a.puntual.tomas.map((x) => [`toma${x.toma}`, x === t ? tomaConReplica(x, replica, { revisor }) : x]),
      ),
    };
    const out = await this.predictor.predict({ study, patient, hints, params });
    const despues = await this.analyses.update(a.id, out);
    this.events.publish(EVENTS.ANALYSIS_COMPLETED, {
      actor,
      entity: 'estudio',
      entityId: study.id,
      detail: `${patient.codigo}: toma ${toma} con la foto ${replica.rep} · ${a.categoria} → ${despues.categoria}`,
    });
    return { antes: a, despues };
  }

  async forStudy(studyId) {
    return this.analyses.findByStudyId(studyId);
  }

  async count() {
    return this.analyses.count();
  }
}

module.exports = AnalysisService;
