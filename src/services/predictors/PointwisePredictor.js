'use strict';

const UlcerPredictor = require('./UlcerPredictor');
const MockUlcerPredictor = require('./MockUlcerPredictor');
const { analyzePointwise } = require('./pointwiseAnalysis');
const { loadModel, featureVector, applyModel, COMPARISON_PATH } = require('./pointwiseModel');
const { loadReferenceStore, referenceFor } = require('./tciReference');
const { loadPatternModel, predictPattern, patternModelInfo } = require('./diabeticPattern');
const { ANGIOSOMA_METODO, REFERENCE_SOURCES } = require('../../imaging/tci');
const { categoryFor, DELTA_T_UMBRAL, thermalGroup } = require('../../config/domain');
const { DEFAULT_PARAMS } = require('../../config/settings');

const IS2 = 'application/x-fluke-is2';

/** AUC de validación cruzada mínima para que la categoría de riesgo use la probabilidad del modelo. */
const AUC_MINIMA_MODELO = 0.7;

/**
 * Categoría por el HALLAZGO TÉRMICO punto a punto (se usa mientras el modelo
 * no demuestre capacidad de discriminar): sin asimetría → «sin riesgo»;
 * área caliente ≥ mínima → «moderado»; además con |ΔT| p95 ≥ referencia
 * bibliográfica → «alto».
 */
function categoriaTermica(toma, p) {
  const m = toma?.metricas;
  if (!m || !toma.conAsimetria) return 'sin_riesgo';
  return m.p95Abs >= (p.referencia ?? 2.2) ? 'alto' : 'moderado';
}

function summarize(rois, umbral, corteSimetria) {
  const regionales = rois.filter((r) => r.roi !== 'general');
  if (!regionales.length) return { grupo: null, simetrico: null, deltaTMax: null, deltaTMaxRoi: null };
  const maxRow = regionales.reduce((m, r) => (Math.abs(r.deltaT) > Math.abs(m.deltaT) ? r : m), regionales[0]);
  return { ...thermalGroup(rois, umbral, corteSimetria), deltaTMax: maxRow.deltaT, deltaTMaxRoi: maxRow.roi };
}

/**
 * Estrategia por defecto (`puntual-v1`): análisis PUNTO A PUNTO de cada toma
 * y modelo logístico PRELIMINAR sobre sus features.
 *
 * Fuente de las grillas canónicas, por orden de preferencia:
 *  1. `hints.puntual` (grillas precalculadas: datos reales locales, imágenes
 *     demo o un análisis anterior que se recalcula);
 *  2. los archivos .IS2 subidos (se procesan en el momento: una sola vez por
 *     estudio, al cargarlo).
 * Si no hay grillas (p. ej. se subieron JPG/PNG, que no son radiométricos),
 * delega en el predictor simulado y lo informa (`simulado: true`).
 *
 * La toma 2 es opcional: sin ella se analiza sólo la toma 1 («Sin toma 2»).
 * Las regiones de la Parte 1 se derivan de la misma grilla y se guardan como
 * referencia secundaria (`rois`, `roisToma1`).
 */
class PointwisePredictor extends UlcerPredictor {
  constructor({
    model = loadModel(),
    umbral = DELTA_T_UMBRAL,
    fallback = new MockUlcerPredictor(),
    realDataDir = null,
    tciStore = null,
    patternModel = loadPatternModel(),
  } = {}) {
    super();
    this.patternModel = patternModel;
    this.model = model;
    this.umbral = umbral;
    this.fallback = fallback;
    this.realDataDir = realDataDir;
    this._tciStore = tciStore;
  }

  /** Patrón de referencia del TCI (real local si existe; si no, el de demostración). Perezoso. */
  get tciStore() {
    if (!this._tciStore) this._tciStore = loadReferenceStore(this.realDataDir);
    return this._tciStore;
  }

  get info() {
    const v = this.model?.validacion;
    return {
      id: 'puntual',
      version: 'puntual-v1',
      nombre: 'Análisis punto a punto + patrón térmico (base pública)',
      descripcion:
        'Segmenta ambos pies, espeja el derecho, los registra (centroide, eje principal y escala) y compara punto a punto. Informa además si el patrón térmico es compatible con pie diabético (modelo entrenado con la base pública 2019, diabetes vs control; no predice úlcera). La categoría sale del hallazgo térmico.',
      comparacion: loadModel(COMPARISON_PATH),
      patronDm: patternModelInfo(this.patternModel),
      tci: {
        angiosomas: ANGIOSOMA_METODO,
        referencia: REFERENCE_SOURCES[this.tciStore?.fuente] || this.tciStore?.descripcion || null,
      },
      modelo: this.model
        ? {
            version: this.model.version,
            desenlace: this.model.desenlace,
            n: v?.n ?? null,
            auc: v?.auc ?? null,
            aucIC95: v?.aucIC95 ?? null,
            aucKFold: v?.kFold?.aucMedia ?? null,
            metodo: v?.metodo ?? null,
            features: this.model.features.map((f) => f.nombre),
          }
        : null,
    };
  }

  /** Procesa los IS2 subidos (si los hay) y devuelve las grillas por toma. */
  static gridsFromImages(images) {
    const { analyzeIs2Pointwise, is2CaptureDate } = require('../../imaging/pointwise');
    const out = {};
    for (const slot of ['toma1', 'toma2']) {
      const img = (images || []).find((i) => i.slot === slot);
      if (!img?.buffer || img.mime !== IS2) continue;
      try {
        const r = analyzeIs2Pointwise(img.buffer);
        if (r.ok) out[slot] = { ...r, fecha: is2CaptureDate(img.buffer) };
      } catch {
        // archivo ilegible: esa toma queda sin análisis punto a punto
      }
    }
    return out.toma1 || out.toma2 ? out : null;
  }

  async predict({ patient, study, images = [], hints = null, params = null }) {
    const p = { ...DEFAULT_PARAMS, umbral: this.umbral, ...(params || {}) };
    let grids = hints?.puntual || null;
    if (!grids) grids = PointwisePredictor.gridsFromImages(images);
    // Si sólo llegó la toma 2 se la trata como única toma disponible.
    if (grids && !grids.toma1 && grids.toma2) grids = { toma1: grids.toma2 };
    if (!grids) {
      const out = await this.fallback.predict({ patient, study, images, hints, params });
      return { ...out, puntual: null };
    }

    const tciReference = referenceFor(this.tciStore, patient?.codigo ?? null);
    const { rois: roisPorToma, ...puntual } = analyzePointwise(grids, p, { tciReference });
    const actual = puntual.tomas.at(-1);
    const rois = roisPorToma[`toma${actual.toma}`] || [];
    const roisToma1 = puntual.tieneToma2 ? roisPorToma.toma1 || [] : [];
    const s2 = summarize(rois, p.umbral, p.corteSimetria);
    const s1 = puntual.tieneToma2 ? summarize(roisToma1, p.umbral, p.corteSimetria) : null;

    const x = this.model
      ? featureVector(actual, { umbralPixel: this.model.umbralPixel, keys: this.model.features.map((f) => f.key) })
      : null;
    const pred = applyModel(this.model, x);
    const probabilidad = pred ? pred.probabilidad : null;
    const v = this.model?.validacion;
    puntual.modelo = this.model
      ? {
          version: this.model.version,
          desenlace: this.model.desenlace,
          n: v?.n ?? null,
          auc: v?.auc ?? null,
          aucIC95: v?.aucIC95 ?? null,
          aucKFold: v?.kFold?.aucMedia ?? null,
          metodo: v?.metodo ?? null,
          tomaUsada: actual.toma,
        }
      : null;

    // Patrón térmico compatible con pie diabético (modelo con etiqueta real de la
    // base pública). Se informa aparte: NO es riesgo de úlcera y no cambia la categoría.
    puntual.patronDm = predictPattern(this.patternModel, actual);
    for (const t of puntual.tomas) {
      t.patronDm =
        t === actual
          ? (puntual.patronDm?.probabilidad ?? null)
          : (predictPattern(this.patternModel, t)?.probabilidad ?? null);
    }

    const modeloValido = Boolean(this.model) && (v?.auc ?? 0) >= AUC_MINIMA_MODELO && probabilidad !== null;
    puntual.categoriaPor = modeloValido ? 'modelo' : 'hallazgo_termico';
    const categoria = modeloValido
      ? categoryFor(probabilidad, { moderado: p.corteModerado, alto: p.corteAlto })
      : categoriaTermica(actual, p);

    return {
      predictorVersion: this.info.version,
      fuenteRois: 'puntual',
      rois,
      roisToma1,
      deltaTMax: s2.deltaTMax ?? 0,
      deltaTMaxRoi: s2.deltaTMaxRoi ?? 'general',
      grupo: s2.grupo,
      simetrico: s2.simetrico,
      deltaTMaxToma1: s1 ? s1.deltaTMax : null,
      deltaTMaxRoiToma1: s1 ? s1.deltaTMaxRoi : null,
      grupoToma1: s1 ? s1.grupo : null,
      simetricoToma1: s1 ? s1.simetrico : null,
      umbral: p.umbral,
      probabilidad: probabilidad ?? 0,
      categoria,
      horizonteSemanas: p.horizonteSemanas,
      parametros: p,
      factores: pred ? pred.factores.sort((a, b) => Math.abs(b.contribucion) - Math.abs(a.contribucion)) : [],
      puntual,
      simulado: false,
    };
  }
}

module.exports = PointwisePredictor;
module.exports.AUC_MINIMA_MODELO = AUC_MINIMA_MODELO;
module.exports.categoriaTermica = categoriaTermica;
