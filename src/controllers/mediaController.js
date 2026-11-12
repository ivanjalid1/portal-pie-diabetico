'use strict';

/** Sirve imágenes de estudios previa verificación de permisos. */
function createMediaController({ studyService }) {
  return {
    async studyImage(req, res) {
      const access = await studyService.getImageAccess(req.params.studyId, req.params.slot, req.user, {
        render: req.query.vista === 'png',
        palette: ['alto_contraste', 'ironbow', 'grises'].includes(req.query.paleta) ? req.query.paleta : undefined,
      });
      res.set('Cache-Control', 'private, no-store');
      if (access.type === 'redirect') return res.redirect(302, access.url);
      res.type(access.mime);
      if (!/^image\/(png|jpeg)$/.test(access.mime)) {
        // TIFF e IS2 no se muestran en el navegador: se descargan.
        res.attachment(access.filename || 'estudio');
      }
      res.set('X-Content-Type-Options', 'nosniff');
      return res.send(access.buffer);
    },
  };
}

module.exports = { createMediaController };
