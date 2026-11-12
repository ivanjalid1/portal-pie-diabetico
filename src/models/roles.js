'use strict';

/** Roles del sistema (RBAC). */
const ROLES = Object.freeze({
  ADMIN: 'admin',
  MEDICO: 'medico',
  PACIENTE: 'paciente',
});

const ROLE_LABELS = Object.freeze({
  admin: 'Administrador',
  medico: 'Médico/a',
  paciente: 'Paciente',
});

/** Ruta de inicio de cada rol. */
const ROLE_HOME = Object.freeze({
  admin: '/admin',
  medico: '/medico',
  paciente: '/paciente',
});

module.exports = { ROLES, ROLE_LABELS, ROLE_HOME };
