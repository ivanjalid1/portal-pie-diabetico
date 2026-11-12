'use strict';

const AuditService = require('../services/AuditService');
const { INSTITUCIONES } = require('../config/domain');

function createAdminController({ dashboardService, userService, auditService }) {
  const actor = (req) => ({ id: req.user.id, email: req.user.email, ip: req.ip });

  return {
    async dashboard(req, res) {
      const stats = await dashboardService.admin();
      res.render('admin/dashboard', { title: 'Resumen del sistema', stats, actionLabel: AuditService.label });
    },

    async users(req, res) {
      const role = ['admin', 'medico', 'paciente'].includes(req.query.rol) ? req.query.rol : undefined;
      const users = await userService.list({ role });
      const counts = await userService.countByRole();
      res.render('admin/users', { title: 'Usuarios', users, role, counts });
    },

    newMedico(req, res) {
      res.render('admin/medico-form', { title: 'Nuevo médico/a', instituciones: INSTITUCIONES });
    },

    async createMedico(req, res) {
      const { user, tempPassword } = await userService.createMedico(req.validated, actor(req));
      // La contraseña temporal se muestra una única vez y no se guarda en la sesión.
      res.render('admin/credentials', {
        title: 'Cuenta creada',
        account: user,
        tempPassword,
        backHref: '/admin/usuarios',
        backLabel: 'Volver a usuarios',
      });
    },

    async toggleActive(req, res) {
      const user = await userService.setActive(req.params.id, req.body.activo === 'true', actor(req));
      req.flash('success', `${user.email}: cuenta ${user.activo ? 'activada' : 'desactivada'}.`);
      res.redirect(303, '/admin/usuarios');
    },

    async resetPassword(req, res) {
      const { user, tempPassword } = await userService.resetPassword(req.params.id, actor(req));
      res.render('admin/credentials', {
        title: 'Contraseña restablecida',
        account: user,
        tempPassword,
        backHref: '/admin/usuarios',
        backLabel: 'Volver a usuarios',
      });
    },

    async audit(req, res) {
      const action = typeof req.query.accion === 'string' && req.query.accion ? req.query.accion : undefined;
      const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '';
      const entries = await auditService.list({ action, q, limit: 300 });
      res.render('admin/audit', {
        title: 'Auditoría',
        entries,
        action,
        q,
        actions: AuditService.actions,
        actionLabel: AuditService.label,
      });
    },
  };
}

module.exports = { createAdminController };
