'use strict';

const { ROLES } = require('../models/roles');
const { resumenTexto, guardadoTexto, FILTROS } = require('../services/ImageReviewService');
const { fotoDeQuery } = require('./medicoController');

/** Etiquetas de los filtros de la página (mismo orden que FILTROS). */
const FILTRO_LABELS = Object.freeze({
  pendiente: 'Falta revisar',
  aprobado: 'Aprobadas',
  rechazado: 'Rechazadas',
  calidad: 'Calidad baja',
  avisos: 'Con avisos automáticos',
  todas: 'Todas',
});

/** Vuelta segura después de guardar sin JS: sólo a la página de revisión. */
const safeBack = (v, fallback) => (typeof v === 'string' && /^\/revision(?:[/?#]|$)/.test(v) ? v : fallback);

/**
 * Página «Revisión de fotos» (médico/a y administrador/a): todas las fotos
 * del visor en una grilla con Aprobado / Rechazado / Falta revisar, y un
 * visor de sólo lectura (contexto) para el administrador/a, que no tiene
 * páginas de estudio. La revisión vive sólo en esta sección. El acceso a cada estudio lo resuelve StudyService#getForReviewer.
 */
function createReviewController({ studyService, viewerService, imageReviewService }) {
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
      const data = await imageReviewService.overview(req.user, { estado, q, page });
      res.render('revision/index', {
        title: 'Revisión de fotos',
        ...data,
        FILTROS,
        FILTRO_LABELS,
        guardadoTexto,
        studyHref: (f) => studyHref(req, f.studyId, f.toma, f.replica),
        backUrl: req.originalUrl,
      });
    },

    /** Visor de sólo lectura de un estudio (contexto; sin controles de revisión). */
    async study(req, res) {
      const { study, patient } = await studyService.getForReviewer(req.params.id, req.user);
      const visor = await viewerService.sources(study, patient).catch(() => []);
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

    /** Guarda la revisión de una foto (JSON con JS; si no, vuelve a la página). */
    async save(req, res) {
      const { id, toma, rep } = req.params;
      await imageReviewService.save(id, { toma, replica: rep, ...req.validated }, actor(req));
      if (req.accepts(['html', 'json']) === 'json') {
        const { study, patient } = await studyService.getForReviewer(id, req.user);
        const visor = await viewerService.sources(study, patient, { info: false });
        const { fotos, resumen } = await imageReviewService.forStudy(study, visor);
        const foto = fotos.find((f) => f.toma === Number(toma) && f.replica === Number(rep));
        return res.json({
          revision: { ...foto, guardado: guardadoTexto(foto, res.locals.fmt) },
          resumen,
          resumenTexto: resumenTexto(resumen),
        });
      }
      req.flash('success', `Guardaste la revisión de la foto (toma ${toma}, réplica ${rep}).`);
      return res.redirect(303, safeBack(req.body?.volver, `/revision/estudios/${id}#revision-t${toma}-r${rep}`));
    },
  };
}

module.exports = { createReviewController, FILTRO_LABELS };
