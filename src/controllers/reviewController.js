'use strict';

const { ROLES } = require('../models/roles');
const { guardadoTexto, FILTROS } = require('../services/TomaReviewService');
const { RISK_CATEGORIES } = require('../config/domain');
const MaskCorrection = require('../models/MaskCorrection');
const { ThermalViewerService } = require('../services/ThermalViewerService');
const { fotoDeQuery } = require('./medicoController');

/** Etiquetas de los filtros de la página (mismo orden que FILTROS). */
const FILTRO_LABELS = Object.freeze({
  pendiente: 'Falta revisar',
  aprobado: 'Aprobadas',
  rechazado: 'Rechazadas',
  calidad: 'Calidad baja',
  avisos: 'Con avisos',
  todas: 'Todas',
});

/** Vuelta segura después de guardar sin JS: sólo a la página de revisión. */
const safeBack = (v, fallback) => (typeof v === 'string' && /^\/revision(?:[/?#]|$)/.test(v) ? v : fallback);

/**
 * Página «Revisión de fotos» (médico/a y administrador/a): una tarjeta por
 * TOMA con todas sus fotos (réplicas) lado a lado; el revisor elige cuál se
 * usa en el análisis y marca la toma Aprobada / Rechazada / Falta revisar. Un
 * visor de sólo lectura (contexto) sirve al administrador/a, que no tiene
 * páginas de estudio. La revisión vive sólo en esta sección. El acceso a cada
 * estudio lo resuelve StudyService#getForReviewer.
 */
function createReviewController({ studyService, viewerService, tomaReviewService, maskCorrectionService }) {
  const actor = (req) => ({ id: req.user.id, email: req.user.email, ip: req.ip, role: req.user.role });
  const studyHref = (req, studyId, toma, rep) =>
    req.user.role === ROLES.MEDICO
      ? `/medico/estudios/${studyId}?foto=${toma}-${rep}#visor`
      : `/revision/estudios/${studyId}?foto=${toma}-${rep}&volver=${encodeURIComponent(req.originalUrl)}#visor`;

  return {
    async page(req, res) {
      const estado = FILTROS.includes(req.query.estado) ? req.query.estado : FILTROS[0];
      const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 40) : '';
      const page = Math.max(1, Number.parseInt(req.query.pagina, 10) || 1);
      const data = await tomaReviewService.overview(req.user, { estado, q, page });
      res.render('revision/index', {
        title: 'Revisión de fotos',
        ...data,
        FILTROS,
        FILTRO_LABELS,
        guardadoTexto,
        studyHref: (t, rep = t.usada) => studyHref(req, t.studyId, t.toma, rep),
        contornoHref: (t, rep) =>
          `/revision/estudios/${t.studyId}/tomas/${t.toma}/fotos/${rep}/contorno?volver=${encodeURIComponent(`${req.originalUrl}#toma-${t.studyId}-${t.toma}`)}`,
        META_CONTORNOS: MaskCorrection.META,
        backUrl: req.originalUrl,
      });
    },

    /** Visor de sólo lectura de un estudio (contexto; sin controles de revisión). */
    async study(req, res) {
      const { study, patient } = await studyService.getForReviewer(req.params.id, req.user);
      const analysis = await studyService.analysisService.forStudy(study.id).catch(() => null);
      const visor = ThermalViewerService.marcarUsadas(
        await viewerService.sources(study, patient).catch(() => []),
        analysis,
      );
      res.render('revision/estudio', {
        title: `Fotos de ${patient.codigo}`,
        study,
        codigo: patient.codigo,
        visor,
        fotoSel: fotoDeQuery(req.query.foto),
        volver: safeBack(req.query.volver, '/revision'),
      });
    },

    async thermal(req, res) {
      const { study, patient } = await studyService.getForReviewer(req.params.id, req.user);
      const buf = await viewerService.thermal(study, patient, req.params.toma, req.params.rep);
      res.set('Cache-Control', 'private, max-age=600');
      res.set('X-Content-Type-Options', 'nosniff');
      res.type('application/octet-stream').send(buf);
    },

    async photo(req, res) {
      const { study, patient } = await studyService.getForReviewer(req.params.id, req.user);
      const jpeg = await viewerService.visible(study, patient, req.params.toma, req.params.rep);
      res.set('Cache-Control', 'private, no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      res.type('image/jpeg').send(jpeg);
    },

    /** Miniatura PNG de la térmica (escala fija 24–35 °C). */
    async thumbnail(req, res) {
      const { study, patient } = await studyService.getForReviewer(req.params.id, req.user);
      const png = await viewerService.thumbnail(study, patient, req.params.toma, req.params.rep);
      res.set('Cache-Control', 'private, max-age=3600');
      res.set('X-Content-Type-Options', 'nosniff');
      res.type('image/png').send(png);
    },

    /** Editor de contorno de una foto (pincel y goma sobre la térmica, con la foto visible). */
    async contorno(req, res) {
      const { id, toma, rep } = req.params;
      const m = await maskCorrectionService.editor(id, toma, rep, req.user);
      const visor = await viewerService.sources(m.study, m.patient).catch(() => []);
      const r = visor.find((v) => v.toma === m.toma)?.reps.find((x) => x.rep === m.rep) || null;
      const base = `/revision/estudios/${id}/visor/${m.toma}/${m.rep}`;
      res.render('revision/contorno', {
        title: `Contorno ${m.patient.codigo} · toma ${m.toma}`,
        m,
        codigo: m.patient.codigo,
        source: {
          toma: m.toma,
          origen: 'real',
          reps: [
            {
              rep: m.rep,
              calidad: null,
              mejor: true,
              noValido: false,
              info: null,
              alineacion: r?.alineacion || null,
              termica: `${base}/termica.bin`,
              foto: r?.foto ? `${base}/foto.jpg` : null,
            },
          ],
        },
        urls: {
          masks: `/revision/estudios/${id}/tomas/${m.toma}/fotos/${m.rep}/contorno.json`,
          save: `/revision/estudios/${id}/tomas/${m.toma}/fotos/${m.rep}/contorno`,
          reset: `/revision/estudios/${id}/tomas/${m.toma}/fotos/${m.rep}/contorno/quitar`,
        },
        volver: safeBack(req.query.volver, '/revision'),
      });
    },

    /** Contornos (RLE) del editor: automático y corregido. */
    async contornoJson(req, res) {
      const { id, toma, rep } = req.params;
      const m = await maskCorrectionService.editor(id, toma, rep, req.user);
      res.set('Cache-Control', 'no-store');
      res.json({
        width: m.width,
        height: m.height,
        base: m.base,
        automatica: m.automatica,
        corregida: m.corregida,
        corregidoPor: m.corregidoPor,
        corregidoAt: m.corregidoAt,
      });
    },

    /** Guarda el contorno corregido (JSON) y, si es la foto usada, vuelve a analizar la toma. */
    async contornoSave(req, res) {
      const { id, toma, rep } = req.params;
      const { analisis } = await maskCorrectionService.save(
        id,
        toma,
        rep,
        { rle: req.body?.rle, origen: req.body?.origen },
        actor(req),
      );
      const cat = (k) => RISK_CATEGORIES[k]?.nombre || k || null;
      res.json({
        ok: true,
        guardado: `Contorno corregido por ${req.user.nombreCompleto || 'vos'} · ${res.locals.fmt.dateTime(new Date().toISOString())}`,
        analisis: analisis ? { antes: cat(analisis.antes.categoria), despues: cat(analisis.despues.categoria) } : null,
      });
    },

    /** Quita el contorno corregido (vuelve al automático). */
    async contornoReset(req, res) {
      const { id, toma, rep } = req.params;
      const { analisis } = await maskCorrectionService.reset(id, toma, rep, actor(req));
      if (req.accepts(['html', 'json']) === 'json') return res.json({ ok: true, analisis: Boolean(analisis) });
      req.flash('success', 'La foto volvió al contorno automático.');
      return res.redirect(303, safeBack(req.body?.volver, '/revision'));
    },

    /** Guarda la revisión de una toma (JSON con JS; si no, vuelve a la página). */
    async save(req, res) {
      const { id, toma } = req.params;
      const { analisis } = await tomaReviewService.save(id, toma, req.validated, actor(req));
      if (req.accepts(['html', 'json']) === 'json') {
        const { study, patient } = await studyService.getForReviewer(id, req.user);
        const t = await tomaReviewService.forToma(study, patient, toma);
        const cat = (k) => RISK_CATEGORIES[k]?.nombre || k || null;
        return res.json({
          revision: { ...t, guardado: guardadoTexto(t, res.locals.fmt) },
          analisis: analisis
            ? {
                antes: cat(analisis.antes.categoria),
                despues: cat(analisis.despues.categoria),
                cambioCategoria: analisis.antes.categoria !== analisis.despues.categoria,
              }
            : null,
        });
      }
      req.flash(
        'success',
        `Guardaste la revisión de la toma ${toma}.` +
          (analisis
            ? ` El análisis se recalculó con la foto elegida (${RISK_CATEGORIES[analisis.despues.categoria]?.nombre || analisis.despues.categoria}).`
            : ''),
      );
      return res.redirect(303, safeBack(req.body?.volver, '/revision'));
    },
  };
}

module.exports = { createReviewController, FILTRO_LABELS };
