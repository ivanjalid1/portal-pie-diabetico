'use strict';

const { ValidationError } = require('../utils/errors');
const { GROUPS, DEFINITIONS, DEFAULTS } = require('../config/settings');

/** Configuración de los parámetros del análisis (médico/a y administrador/a). */
function createSettingsController({ settingsService, analysisService }) {
  const actor = (req) => ({ id: req.user.id, email: req.user.email, ip: req.ip, role: req.user.role });

  async function render(res, { values, errors = {}, status = 200 } = {}) {
    const meta = await settingsService.load();
    const current = values || meta.values;
    const preview = await settingsService.preview(current);
    res.status(status).render('config/settings', {
      title: 'Configuración',
      groups: GROUPS,
      defs: DEFINITIONS,
      defaults: DEFAULTS,
      values: current,
      saved: meta.values,
      meta,
      preview,
      errors,
    });
  }

  return {
    async show(req, res) {
      await render(res, {
        values: Object.keys(res.locals.old || {}).length ? res.locals.old : null,
        errors: res.locals.errors,
      });
    },

    async save(req, res) {
      try {
        const changes = await settingsService.update(req.body, actor(req));
        req.flash(
          'success',
          changes.length
            ? `Guardado: ${changes.length} ${changes.length === 1 ? 'cambio' : 'cambios'}. Se aplica a los estudios nuevos.`
            : 'No había cambios para guardar.',
        );
        res.redirect(303, '/configuracion');
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        res.locals.flashes = [{ type: 'error', message: err.message }];
        await render(res, { values: { ...DEFAULTS, ...req.body }, errors: err.fields, status: 422 });
      }
    },

    /** Vista previa (JSON) del efecto de los valores del formulario, sin guardar. */
    async preview(req, res) {
      res.json(await settingsService.preview(req.body || {}));
    },

    async recalculate(req, res) {
      const { actualizados, cambiaron } = await analysisService.recalculateAll(actor(req));
      req.flash(
        'success',
        `Recalculados: ${actualizados} ${actualizados === 1 ? 'estudio' : 'estudios'} (${cambiaron} cambiaron de clasificación o de riesgo).`,
      );
      res.redirect(303, '/configuracion');
    },
  };
}

module.exports = { createSettingsController };
