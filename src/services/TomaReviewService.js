'use strict';

const TomaReview = require('../models/TomaReview');
const { RISK_CATEGORIES } = require('../config/domain');
const { EVENTS } = require('../utils/eventBus');
const { NotFoundError, ValidationError } = require('../utils/errors');

/** Filtros de la página «Revisión de fotos» (el primero es el predeterminado). */
const FILTROS = Object.freeze(['pendiente', 'aprobado', 'rechazado', 'calidad', 'avisos', 'todas']);
const FILTRO_OK = {
  pendiente: (t) => t.estado === 'pendiente',
  aprobado: (t) => t.estado === 'aprobado',
  rechazado: (t) => t.estado === 'rechazado',
  calidad: (t) => t.calidadBaja,
  avisos: (t) => t.avisos.length > 0,
  todas: () => true,
};

/** Promise.all con un máximo de `n` tareas a la vez (manifiestos remotos). */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** «Guardado por Nombre Apellido · 26/11/2026 10:30» (vacío si nunca se guardó). */
function guardadoTexto(t, fmt) {
  if (!t?.revisadoAt) return '';
  return `Guardado por ${t.revisor || 'un usuario'} · ${fmt.dateTime(t.revisadoAt)}`;
}

/** «Foto 2 de 3 · elegida por Nombre» / «Foto 1 de 3 · sugerida automáticamente». */
function usadaTexto(t) {
  const n = t.reps.length;
  const origen = t.replicaElegida ? `elegida por ${t.revisor || 'un usuario'}` : 'sugerida automáticamente';
  return `Foto ${t.usada}${n > 1 ? ` de ${n}` : ''} · ${origen}`;
}

const sugeridaDe = (v) => (v.reps.find((r) => r.mejor) || v.reps[0])?.rep ?? null;

/**
 * Revisión manual de las TOMAS de los estudios. Por toma se usa UNA foto
 * (réplica): la elegida por el revisor o, si no eligió, la sugerida por los
 * criterios automáticos de calidad. Elegir otra foto vuelve a analizar esa
 * toma con sus datos precalculados (ReplicaStore → AnalysisService#rerunToma)
 * y cambia la imagen de la toma del estudio. El estado (aprobada, rechazada o
 * «Falta revisar») y el comentario son sólo marcas: una toma rechazada no se
 * excluye del análisis.
 */
class TomaReviewService {
  constructor({
    reviews,
    users,
    studyService,
    viewerService = null,
    replicaStore = null,
    analysisService = null,
    studies = null,
    maskCorrectionService = null,
    events,
  }) {
    this.reviews = reviews;
    this.users = users;
    this.studyService = studyService;
    this.viewerService = viewerService;
    this.replicaStore = replicaStore;
    this.analysisService = analysisService;
    this.studies = studies;
    this.maskCorrectionService = maskCorrectionService;
    this.events = events;
  }

  /** Nombres de los revisores (id → nombre completo). */
  async reviewerNames(rows) {
    const ids = [...new Set(rows.map((r) => r.revisadoPor).filter(Boolean))];
    return new Map((ids.length ? await this.users.findByIds(ids) : []).map((u) => [u.id, u.nombreCompleto]));
  }

  /** Toma del visor + su revisión → ítem de la página. */
  static item({ study, patient, v, r, revisor, contornos = new Map() }) {
    const sugerida = sugeridaDe(v);
    const elegida = r.replicaElegida && v.reps.some((x) => x.rep === r.replicaElegida) ? r.replicaElegida : null;
    const usada = elegida ?? sugerida;
    const usadaRep = v.reps.find((x) => x.rep === usada) || null;
    const t = {
      studyId: study.id,
      codigo: patient.codigo,
      fechaToma: v.toma === 1 ? study.fechaToma1 || study.fechaHora : study.fechaHora,
      toma: v.toma,
      // «real»: fotos del precálculo, con contorno corregible.
      origen: v.origen || null,
      reps: v.reps.map((x) => ({
        rep: x.rep,
        sugerida: x.rep === sugerida,
        usada: x.rep === usada,
        avisos: x.avisos || [],
        foto: Boolean(x.foto),
        calidad: x.calidad ?? null,
        // Contorno de los pies corregido a mano en esta foto: { por, at } o null.
        contorno: contornos.get(`${study.id}:${v.toma}:${x.rep}`) || null,
      })),
      sugerida,
      usada,
      replicaElegida: elegida,
      estado: r.estado,
      etiqueta: r.etiqueta,
      comentario: r.comentario,
      revisor,
      revisadoAt: r.revisadoAt,
      calidadBaja: Boolean(v.calidadBaja),
      // Avisos automáticos de la foto que se usa.
      avisos: usadaRep?.avisos || [],
    };
    t.usadaTexto = usadaTexto(t);
    return t;
  }

  /**
   * Todas las tomas que el usuario puede revisar (médico/a: sus estudios;
   * administrador/a: todos), con el progreso, los conteos por filtro y la
   * página pedida. Primero las tomas con calidad baja. Sólo expone el código
   * del paciente (nunca nombre ni DNI).
   * @param {{estado?:string, q?:string, page?:number, size?:number}} f
   */
  async overview(user, { estado = FILTROS[0], q = '', page = 1, size = 24 } = {}) {
    const filtro = FILTROS.includes(estado) ? estado : FILTROS[0];
    const items = await this.studyService.listForReviewer(user);
    const visores = await mapLimit(items, 8, ({ study, patient }) =>
      this.viewerService ? this.viewerService.sources(study, patient, { info: false }).catch(() => []) : [],
    );
    const rows = items.length ? await this.reviews.listByStudyIds(items.map((x) => x.study.id)) : [];
    const byKey = new Map(rows.map((r) => [`${r.studyId}:${r.toma}`, r]));
    const names = await this.reviewerNames(rows);
    const contornos = this.maskCorrectionService
      ? await this.maskCorrectionService.byStudies(items.map((x) => x.study.id))
      : new Map();

    const todas = [];
    items.forEach(({ study, patient }, i) => {
      for (const v of visores[i]) {
        if (!v.reps?.length) continue;
        const r = byKey.get(`${study.id}:${v.toma}`) || new TomaReview({ studyId: study.id, toma: v.toma });
        const revisor = r.revisadoPor ? names.get(r.revisadoPor) || null : null;
        todas.push(TomaReviewService.item({ study, patient, v, r, revisor, contornos }));
      }
    });
    todas.sort(
      (a, b) =>
        Number(b.calidadBaja) - Number(a.calidadBaja) ||
        a.codigo.localeCompare(b.codigo, 'es', { numeric: true }) ||
        String(a.studyId).localeCompare(String(b.studyId)) ||
        a.toma - b.toma,
    );

    const conteos = Object.fromEntries(FILTROS.map((k) => [k, todas.filter(FILTRO_OK[k]).length]));
    const resumen = {
      total: todas.length,
      revisadas: conteos.aprobado + conteos.rechazado,
      aprobado: conteos.aprobado,
      rechazado: conteos.rechazado,
      pendiente: conteos.pendiente,
    };
    const needle = String(q || '')
      .trim()
      .toLowerCase();
    const tomas = todas.filter((t) => FILTRO_OK[filtro](t) && (!needle || t.codigo.toLowerCase().includes(needle)));
    const pages = Math.max(1, Math.ceil(tomas.length / size));
    const pg = Math.min(Math.max(1, Number(page) || 1), pages);
    return {
      filtro,
      q: needle,
      resumen,
      conteos,
      totalFiltrado: tomas.length,
      // Contornos corregidos a mano (todas las fotos visibles para el usuario).
      contornos: contornos.size,
      tomas: tomas.slice((pg - 1) * size, pg * size),
      page: pg,
      pages,
    };
  }

  /** Revisión vigente de una toma de un estudio ya autorizado (ítem de la página). */
  async forToma(study, patient, toma) {
    const visor = this.viewerService ? await this.viewerService.sources(study, patient, { info: false }) : [];
    const v = visor.find((x) => x.toma === Number(toma));
    if (!v?.reps?.length) throw new NotFoundError('La toma no existe.');
    const r =
      (await this.reviews.listByStudy(study.id)).find((x) => x.toma === Number(toma)) ||
      new TomaReview({ studyId: study.id, toma });
    const revisor = r.revisadoPor ? (await this.reviewerNames([r])).get(r.revisadoPor) || null : null;
    const contornos = this.maskCorrectionService ? await this.maskCorrectionService.byStudies([study.id]) : new Map();
    return TomaReviewService.item({ study, patient, v, r, revisor, contornos });
  }

  /**
   * Guarda la revisión de una toma: el médico/a tratante o el administrador/a
   * (StudyService#getForReviewer). Si la foto usada cambia, vuelve a analizar
   * la toma con esa réplica y cambia la imagen de la toma del estudio.
   * @param {{replica?:number, estado:string, comentario?:string}} input
   *   `replica` vacía = conservar la foto que se usa ahora.
   * @returns {Promise<{review: TomaReview, analisis: null|{antes:object, despues:object}}>}
   */
  async save(studyId, toma, { replica, estado, comentario = '' }, actor) {
    const { study, patient } = await this.studyService.getForReviewer(studyId, actor);
    const t = Number(toma);
    if (![1, 2].includes(t)) throw new NotFoundError('La toma no existe.');
    const visor = this.viewerService ? await this.viewerService.sources(study, patient, { info: false }) : [];
    const v = visor.find((x) => x.toma === t);
    if (!v?.reps?.length) throw new NotFoundError('La toma no existe.');
    const actual = (await this.reviews.listByStudy(studyId)).find((x) => x.toma === t) || null;
    const sugerida = sugeridaDe(v);
    const usadaAntes =
      actual?.replicaElegida && v.reps.some((x) => x.rep === actual.replicaElegida) ? actual.replicaElegida : sugerida;
    const rep = replica === undefined || replica === null ? usadaAntes : Number(replica);
    if (!v.reps.some((x) => x.rep === rep)) throw new NotFoundError('La foto no existe.');
    const replicaElegida = rep === sugerida ? null : rep;

    // ¿El análisis vigente usa otra foto en esta toma (o cambió quién la eligió)? Se vuelve a analizar.
    let analisis = null;
    const a = this.analysisService ? await this.analysisService.forStudy(studyId) : null;
    const ta = a?.puntual?.tomas?.find((x) => x.toma === t) || null;
    const enAnalisis = ta?.calidadFotos?.rep ?? sugerida;
    const nombre = replicaElegida ? (await this.users.findById(actor.id))?.nombreCompleto || 'un usuario' : null;
    const cambiaFoto = Boolean(ta) && enAnalisis !== rep;
    const cambiaOrigen = Boolean(ta?.calidadFotos) && (ta.calidadFotos.elegidaPor || null) !== nombre;
    if (cambiaFoto || (cambiaOrigen && this.replicaStore)) {
      // Con el contorno vigente de esa foto (corregido a mano o automático).
      const entry = this.maskCorrectionService
        ? await this.maskCorrectionService.entry(study, patient, t, rep)
        : this.replicaStore
          ? await this.replicaStore.replica(study, patient, t, rep)
          : null;
      if (!entry) {
        if (cambiaFoto) throw new ValidationError('Esta foto no tiene datos de análisis: no se puede usar en la toma.');
      } else {
        analisis = await this.analysisService.rerunToma(
          { study, patient, toma: t, replica: entry, revisor: nombre },
          actor,
        );
        if (entry.storagePath && this.studies && study.image(`toma${t}`)) {
          await this.studies.updateImage(study.id, `toma${t}`, { storagePath: entry.storagePath });
        }
      }
    }

    const review = await this.reviews.upsert({
      studyId,
      toma: t,
      replicaElegida,
      estado,
      comentario: String(comentario || '').slice(0, TomaReview.COMENTARIO_MAX),
      revisadoPor: actor.id,
      revisadoAt: new Date().toISOString(),
    });
    const cat = (k) => RISK_CATEGORIES[k]?.nombre || k;
    const cambioCat = analisis && analisis.antes.categoria !== analisis.despues.categoria;
    this.events.publish(EVENTS.TOMA_REVIEWED, {
      actor,
      entity: 'estudio',
      entityId: studyId,
      detail:
        `${patient.codigo} · toma ${t}: foto ${rep} (${replicaElegida ? 'elegida' : 'sugerida'}), ${review.etiqueta.toLowerCase()}` +
        (cambioCat ? ` · ${cat(analisis.antes.categoria)} → ${cat(analisis.despues.categoria)}` : ''),
    });
    return { review, analisis };
  }
}

module.exports = { TomaReviewService, guardadoTexto, usadaTexto, FILTROS };
