'use strict';

const { EVENTS } = require('../utils/eventBus');
const { ValidationError } = require('../utils/errors');
const {
  DEFAULTS,
  DEFINITIONS,
  BY_KEY,
  settingsSchema,
  withDefaults,
  analysisParams,
  describe,
} = require('../config/settings');
const { thermalGroup, categoryFor } = require('../config/domain');
const { analyzePointwise } = require('./predictors/pointwiseAnalysis');
const { categoriaTermica } = require('./predictors/PointwisePredictor');
const LiteratureRiskPredictor = require('./predictors/LiteratureRiskPredictor');

/**
 * Configuración global del análisis (parámetros editables).
 *
 * Lee del repositorio y guarda en caché por un tiempo corto: en serverless
 * cada instancia tiene su propia caché, por eso no se usa una caché eterna.
 * Cada cambio publica un evento con el valor anterior y el nuevo, que el
 * `AuditService` registra.
 */
class SettingsService {
  constructor({ settings, analyses, events, ttlMs = 15000, studies = null, patients = null }) {
    this.repo = settings;
    this.analyses = analyses;
    this.studies = studies;
    this.patients = patients;
    this.events = events;
    this.ttlMs = ttlMs;
    this.cache = null;
    this.cachedAt = 0;
  }

  invalidate() {
    this.cache = null;
    this.cachedAt = 0;
  }

  /** Configuración vigente completa (con valores por defecto) y metadatos. */
  async load() {
    if (this.cache && Date.now() - this.cachedAt < this.ttlMs) return this.cache;
    const stored = await this.repo.get();
    this.cache = {
      values: withDefaults(stored.values),
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy,
      overridden: Object.keys(stored.values || {}).filter((k) => BY_KEY[k] && stored.values[k] !== DEFAULTS[k]),
    };
    this.cachedAt = Date.now();
    return this.cache;
  }

  async get() {
    return (await this.load()).values;
  }

  async params() {
    return analysisParams(await this.get());
  }

  /** Valida sin guardar. Devuelve los valores normalizados o lanza ValidationError. */
  validate(input) {
    const merged = {};
    for (const d of DEFINITIONS) merged[d.key] = input?.[d.key] ?? DEFAULTS[d.key];
    const r = settingsSchema.safeParse(merged);
    if (!r.success) {
      const fields = {};
      for (const issue of r.error.issues) {
        const k = issue.path[0];
        if (k && !fields[k]) fields[k] = issue.message;
      }
      throw new ValidationError('Revisá los valores marcados.', fields);
    }
    return r.data;
  }

  /**
   * Guarda los valores modificados. Devuelve la lista de cambios
   * `{ key, label, antes, despues }` (vacía si no hubo cambios).
   */
  async update(input, actor) {
    const next = this.validate(input);
    const current = await this.get();
    const changes = DEFINITIONS.filter((d) => next[d.key] !== current[d.key]).map((d) => ({
      key: d.key,
      label: d.label,
      antes: current[d.key],
      despues: next[d.key],
    }));
    if (!changes.length) return [];
    await this.repo.save(Object.fromEntries(changes.map((c) => [c.key, c.despues])), actor?.id || null);
    this.invalidate();
    this.events.publish(EVENTS.SETTINGS_UPDATED, {
      actor,
      entity: 'configuracion',
      entityId: 'global',
      detail: changes.map((c) => `${c.label}: ${describe(c.key, c.antes)} → ${describe(c.key, c.despues)}`).join('; '),
    });
    return changes;
  }

  /**
   * Efecto de una configuración sobre los estudios existentes (sin guardar):
   * cuántos quedarían «Con asimetría», «Simétricos» y en cada nivel de riesgo.
   * La probabilidad no se recalcula aquí (sólo se reclasifica con los cortes).
   */
  async preview(input) {
    const v = withDefaults({ ...(await this.get()), ...this.validatePartial(input) });
    const all = await this.analyses.listAll();
    // Un análisis por estudio (el más reciente).
    const latest = new Map();
    for (const a of all) {
      const prev = latest.get(a.studyId);
      if (!prev || new Date(a.createdAt) > new Date(prev.createdAt)) latest.set(a.studyId, a);
    }
    const list = [...latest.values()];
    let conAsimetria = 0;
    let conAsimetriaActual = 0;
    let simetricas = 0;
    let conAsimetriaPuntual = 0;
    let conAsimetriaPuntualActual = 0;
    let puntuales = 0;
    const riesgo = { sin_riesgo: 0, moderado: 0, alto: 0 };
    const params = analysisParams(v);
    for (const a of list) {
      const g = thermalGroup(a.rois, v.umbralAsimetria, v.corteSimetria);
      if (g.grupo === 'P') conAsimetria += 1;
      if (a.grupo === 'P') conAsimetriaActual += 1;
      if (g.simetrico) simetricas += 1;
      let categoria = categoryFor(a.probabilidad, { moderado: v.corteModerado, alto: v.corteAlto });
      if (a.puntual) {
        // Se recalculan las métricas punto a punto con los parámetros propuestos (sin reprocesar imágenes).
        const grids = Object.fromEntries(a.puntual.tomas.map((t) => [`toma${t.toma}`, t]));
        const pw = analyzePointwise(grids, params);
        const actual = pw.tomas.at(-1);
        puntuales += 1;
        if (actual?.conAsimetria) conAsimetriaPuntual += 1;
        if (a.puntual.tomas.at(-1)?.conAsimetria) conAsimetriaPuntualActual += 1;
        if (a.puntual.categoriaPor === 'hallazgo_termico') categoria = categoriaTermica(actual, params);
        if (a.puntual.categoriaPor === 'riesgo_bibliografia') {
          const patient = await this.#patientOf(a.studyId);
          categoria = LiteratureRiskPredictor.applyRisk({ puntual: pw }, patient, params).categoria ?? categoria;
        }
      }
      riesgo[categoria] += 1;
    }
    return {
      total: list.length,
      conAsimetria,
      conAsimetriaActual,
      simetricas,
      riesgo,
      puntuales,
      conAsimetriaPuntual,
      conAsimetriaPuntualActual,
    };
  }

  async #patientOf(studyId) {
    if (!this.studies || !this.patients) return null;
    const study = await this.studies.findById(studyId);
    return study ? this.patients.findById(study.patientId) : null;
  }

  /** Validación tolerante para la vista previa: ignora los campos inválidos. */
  validatePartial(input = {}) {
    const out = {};
    for (const d of DEFINITIONS) {
      if (input[d.key] === undefined || input[d.key] === '') continue;
      const one = settingsSchema.shape[d.key].safeParse(input[d.key]);
      if (one.success) out[d.key] = one.data;
    }
    return out;
  }
}

module.exports = SettingsService;
