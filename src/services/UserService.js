'use strict';

const { ROLES } = require('../models/roles');
const { ConflictError, NotFoundError, ValidationError } = require('../utils/errors');
const { EVENTS } = require('../utils/eventBus');
const { temporaryPassword } = require('../utils/random');

/** Gestión de cuentas de usuario (casos de uso del administrador). */
class UserService {
  constructor({ users, authProvider, events }) {
    this.users = users;
    this.authProvider = authProvider;
    this.events = events;
  }

  async list(filter = {}) {
    return this.users.list(filter);
  }

  async get(id) {
    const user = await this.users.findById(id);
    if (!user) throw new NotFoundError('El usuario no existe.');
    return user;
  }

  /**
   * Crea identidad + perfil. Si falla el perfil, se compensa eliminando la
   * identidad para no dejar cuentas huérfanas.
   * @returns {Promise<{user, tempPassword}>}
   */
  async createAccount(profile, { password, mustChangePassword = true } = {}) {
    const email = String(profile.email).trim().toLowerCase();
    if (await this.users.findByEmail(email)) {
      throw new ConflictError('Ya existe una cuenta con ese correo electrónico.');
    }
    const tempPassword = password || temporaryPassword();
    const id = await this.authProvider.createIdentity(email, tempPassword, {
      role: profile.role,
      nombre: profile.nombre,
      apellido: profile.apellido,
    });
    try {
      const user = await this.users.create({ ...profile, id, email, mustChangePassword, activo: true });
      return { user, tempPassword };
    } catch (err) {
      await this.authProvider.deleteIdentity(id).catch(() => {});
      throw err;
    }
  }

  async createMedico(data, actor) {
    const { user, tempPassword } = await this.createAccount({
      email: data.email,
      role: ROLES.MEDICO,
      nombre: data.nombre,
      apellido: data.apellido,
      matricula: data.matricula,
      especialidad: data.especialidad,
      institucion: data.institucion,
    });
    this.events.publish(EVENTS.USER_CREATED, {
      actor,
      entity: 'usuario',
      entityId: user.id,
      detail: `Médico/a ${user.nombreCompleto} (${user.email})`,
    });
    return { user, tempPassword };
  }

  async setActive(id, activo, actor) {
    if (id === actor.id) throw new ValidationError('No podés desactivar tu propia cuenta.');
    const user = await this.get(id);
    const updated = await this.users.update(user.id, { activo: Boolean(activo) });
    this.events.publish(EVENTS.USER_UPDATED, {
      actor,
      entity: 'usuario',
      entityId: id,
      detail: `${user.email}: ${activo ? 'activada' : 'desactivada'}`,
    });
    return updated;
  }

  async resetPassword(id, actor) {
    const user = await this.get(id);
    const tempPassword = temporaryPassword();
    await this.authProvider.updatePassword(user.id, tempPassword);
    await this.users.update(user.id, { mustChangePassword: true });
    this.events.publish(EVENTS.USER_PASSWORD_RESET, {
      actor,
      entity: 'usuario',
      entityId: id,
      detail: user.email,
    });
    return { user, tempPassword };
  }

  async countByRole() {
    return this.users.countByRole();
  }
}

module.exports = UserService;
