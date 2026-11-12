'use strict';

const { EVENTS } = require('../utils/eventBus');

/**
 * Orquesta la ejecución de la estrategia de predicción y persiste el resultado.
 * No conoce el algoritmo concreto: lo recibe inyectado (`predictor`).
 */
class AnalysisService {
  constructor({ predictor, analyses, events }) {
    this.predictor = predictor;
    this.analyses = analyses;
    this.events = events;
  }

  get predictorInfo() {
    return this.predictor.info;
  }

  async run({ study, patient, images }, actor) {
    const output = await this.predictor.predict({ study, patient, images });
    const result = await this.analyses.create({ ...output, studyId: study.id });
    this.events.publish(EVENTS.ANALYSIS_COMPLETED, {
      actor,
      entity: 'estudio',
      entityId: study.id,
      detail: `${patient.codigo}: ${result.probabilidad} % (${result.categoria}) · ${result.predictorVersion}`,
    });
    return result;
  }

  async forStudy(studyId) {
    return this.analyses.findByStudyId(studyId);
  }

  async count() {
    return this.analyses.count();
  }
}

module.exports = AnalysisService;
