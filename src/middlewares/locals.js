'use strict';

const domain = require('../config/domain');
const { fmt } = require('../utils/format');
const thermal = require('../utils/thermal');
const { ROLE_LABELS, ROLE_HOME } = require('../models/roles');

/** Navegación lateral por rol (íconos definidos en partials/icon.ejs). */
const NAV = {
  admin: [
    { href: '/admin', label: 'Resumen', icon: 'gauge', exact: true },
    { href: '/admin/usuarios', label: 'Usuarios', icon: 'users' },
    { href: '/admin/auditoria', label: 'Auditoría', icon: 'list' },
  ],
  medico: [
    { href: '/medico', label: 'Tablero', icon: 'gauge', exact: true },
    { href: '/medico/pacientes', label: 'Pacientes', icon: 'users' },
    { href: '/medico/estudios', label: 'Estudios realizados', icon: 'list', exact: true },
    { href: '/medico/estudios/nuevo', label: 'Nuevo estudio', icon: 'scan' },
    { href: '/medico/controles', label: 'Controles', icon: 'calendar' },
  ],
  paciente: [
    { href: '/paciente', label: 'Inicio', icon: 'home', exact: true },
    { href: '/paciente/estudios', label: 'Mis estudios', icon: 'scan' },
    { href: '/paciente/controles', label: 'Mis controles', icon: 'calendar' },
    { href: '/paciente/autocuidado', label: 'Cuidado de los pies', icon: 'heart' },
    { href: '/paciente/datos', label: 'Mis datos', icon: 'user' },
  ],
};

function locals(config) {
  return function localsMiddleware(req, res, next) {
    res.locals.fmt = fmt;
    res.locals.thermal = thermal;
    const isIs2 = (img) => img?.mime === 'application/x-fluke-is2';
    // Los IS2 se muestran como PNG generado en el servidor (?vista=png).
    res.locals.imageUrl = (study, slot) =>
      `/media/estudios/${study.id}/${slot}${isIs2(study.image?.(slot)) ? '?vista=png' : ''}`;
    res.locals.canPreview = (img) =>
      Boolean(img && (img.publicUrl || isIs2(img) || domain.PREVIEWABLE_TYPES.includes(img.mime)));
    /** Variantes de paleta disponibles para una imagen (demo pre-renderizada o IS2). */
    res.locals.imagePalettes = (study, slot) => {
      const img = study.image?.(slot);
      if (!img) return null;
      const keys = Object.keys(thermal.PALETTES);
      if (img.publicUrl && /^\/demo\/par-\d+-toma\d\.png$/.test(img.publicUrl)) {
        return Object.fromEntries(
          keys.map((k) => [
            k,
            k === thermal.DEFAULT_PALETTE ? img.publicUrl : img.publicUrl.replace('.png', `-${k}.png`),
          ]),
        );
      }
      if (isIs2(img)) {
        const base = `/media/estudios/${study.id}/${slot}?vista=png`;
        return Object.fromEntries(keys.map((k) => [k, `${base}&paleta=${k}`]));
      }
      return null;
    };
    /** Etiqueta clara del grupo térmico (P/C se mantiene sólo en el CSV). */
    res.locals.grupoLabel = (g) => (g === 'P' ? 'Con asimetría (P)' : g === 'C' ? 'Sin asimetría (C)' : 'Sin dato');
    res.locals.grupoAyuda = (umbral = domain.DELTA_T_UMBRAL) =>
      `P = Problema: alguna región supera el umbral de ΔT (${fmt.num(umbral, 1)} °C). C = Control: ninguna región lo supera. No significa sano o enfermo: todos los participantes son diabéticos.`;
    /** «Toma 1: con asimetría → Toma 2: sin asimetría (mejoró)». */
    res.locals.transicionGrupo = (a) => {
      if (!a?.grupoToma1 || !a.grupo) return '';
      const txt = (g) => (g === 'P' ? 'con asimetría' : 'sin asimetría');
      let cambio = 'sin cambios';
      if (a.grupoToma1 === 'P' && a.grupo === 'C') cambio = 'mejoró';
      else if (a.grupoToma1 === 'C' && a.grupo === 'P') cambio = 'empeoró';
      else if (a.roisQueEmpeoran?.length) cambio = 'la asimetría aumentó';
      return `Toma 1: ${txt(a.grupoToma1)} → Toma 2: ${txt(a.grupo)} (${cambio})`;
    };
    res.locals.domain = domain;
    res.locals.appName = config.appName;
    res.locals.currentPath = req.path;
    res.locals.ROLE_LABELS = ROLE_LABELS;
    res.locals.ROLE_HOME = ROLE_HOME;
    res.locals.title = config.appName;
    res.locals.isActive = (item) =>
      item.exact ? req.path === item.href : req.path === item.href || req.path.startsWith(`${item.href}/`);
    res.locals.navFor = (role) => NAV[role] || [];
    res.locals.dataDriver = config.dataDriver;
    next();
  };
}

/**
 * Envuelve cada vista en un layout. Por defecto usa `app` (con barra lateral)
 * si hay sesión y `public` si no; una vista puede pedir otro con `layout`, o
 * ninguno con `layout: false` (p. ej. el informe imprimible).
 */
function layouts(req, res, next) {
  const render = res.render.bind(res);
  res.render = (view, options = {}, callback) => {
    const opts = { ...options };
    const layout = opts.layout === undefined ? (req.user ? 'app' : 'public') : opts.layout;
    if (!layout) return render(view, opts, callback);
    return render(view, opts, (err, body) => {
      if (err) return req.next(err);
      return render(`layouts/${layout}`, { ...opts, body }, callback);
    });
  };
  next();
}

module.exports = { locals, layouts, NAV };
