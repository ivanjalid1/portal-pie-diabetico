'use strict';

const { ROLES } = require('./roles');

/**
 * Entidad Usuario. La identidad es el correo electrónico (p. ej. una cuenta de
 * Gmail del paciente). El hash de contraseña nunca forma parte de la entidad:
 * sólo lo conoce el proveedor de autenticación.
 */
class User {
  constructor(props) {
    this.id = props.id;
    this.email = String(props.email).toLowerCase();
    this.role = props.role;
    this.nombre = props.nombre || '';
    this.apellido = props.apellido || '';
    this.activo = props.activo !== false;
    this.mustChangePassword = Boolean(props.mustChangePassword);
    this.telefono = props.telefono || null;
    this.matricula = props.matricula || null;
    this.especialidad = props.especialidad || null;
    this.institucion = props.institucion || null;
    this.createdAt = props.createdAt || new Date().toISOString();
    this.lastLoginAt = props.lastLoginAt || null;
  }

  get nombreCompleto() {
    return `${this.nombre} ${this.apellido}`.trim() || this.email;
  }

  get iniciales() {
    const n = (this.nombre[0] || '') + (this.apellido[0] || '');
    return (n || this.email[0]).toUpperCase();
  }

  isAdmin() {
    return this.role === ROLES.ADMIN;
  }

  isMedico() {
    return this.role === ROLES.MEDICO;
  }

  isPaciente() {
    return this.role === ROLES.PACIENTE;
  }
}

module.exports = User;
