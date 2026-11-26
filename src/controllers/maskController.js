'use strict';

const { AppError } = require('../utils/errors');

/** Herramienta local de corrección de máscaras (médico/a y administrador/a). */
function createMaskController({ maskService, viewerService = null }) {
  const actor = (req) => ({ id: req.user.id, role: req.user.role });
  const FILTROS = ['pendientes', 'corregidas', 'todas'];

  return {
    /** Corta todas las rutas si la herramienta no está disponible (Vercel, producción, sin datos). */
    available(req, _res, next) {
      if (!maskService?.enabled) return next(new AppError('Página no encontrada.', 404, 'not_found'));
      return next();
    },

    list(req, res) {
      const filtro = FILTROS.includes(req.query.filtro) ? req.query.filtro : 'pendientes';
      const page = Number.parseInt(req.query.page, 10) || 1;
      res.render('mascaras/list', { title: 'Corrección de máscaras', ...maskService.list({ filtro, page }) });
    },

    editor(req, res) {
      const m = maskService.masks(req.params.key);
      const filtro = FILTROS.includes(req.query.filtro) ? req.query.filtro : 'pendientes';
      // Siguiente pendiente (para corregir en serie).
      const pend = maskService.list({ filtro: 'pendientes', perPage: 100000 }).items;
      const next = pend.find((e) => e.key !== m.key) || null;
      res.render('mascaras/editor', {
        title: `Máscara ${m.codigo} · toma ${m.toma}`,
        m,
        foto: Boolean(viewerService?.hasVisibleKey(m.key)),
        info: viewerService?.infoByKey(m.key) || null,
        filtro,
        nextKey: next ? next.key : null,
      });
    },

    image(req, res) {
      const paleta = req.query.paleta === 'grises' ? 'grises' : 'alto_contraste';
      const png = maskService.imagePng(req.params.key, { paleta });
      res.set('Cache-Control', 'private, max-age=3600');
      res.type('png').send(png);
    },

    /** Matriz de temperaturas compacta (TPV1) para el visor. */
    thermal(req, res) {
      maskService.entry(req.params.key);
      res.set('Cache-Control', 'private, max-age=3600');
      res.set('X-Content-Type-Options', 'nosniff');
      res.type('application/octet-stream').send(viewerService.thermalByKey(req.params.key));
    },

    /** Foto visible del IS2 de la réplica (sólo con la carpeta privada local). */
    photo(req, res, next) {
      maskService.entry(req.params.key);
      const jpeg = viewerService?.visibleByKey(req.params.key);
      if (!jpeg) return next(new AppError('Foto no disponible.', 404, 'not_found'));
      res.set('Cache-Control', 'private, no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      return res.type('image/jpeg').send(jpeg);
    },

    masks(req, res) {
      res.set('Cache-Control', 'no-store');
      res.json(maskService.masks(req.params.key));
    },

    save(req, res) {
      const meta = maskService.save(req.params.key, req.body?.rle, actor(req), { origen: req.body?.origen });
      res.json({ ok: true, fecha: meta.fecha, pixeles: meta.pixeles });
    },
  };
}

module.exports = { createMaskController };
