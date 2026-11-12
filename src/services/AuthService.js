'use strict';

const { AuthError, ValidationError } = require('../utils/errors');
const { EVENTS } = require('../utils/eventBus');

/** Casos de uso de autenticación (independientes del proveedor concreto). */
class AuthService {
  constructor({ authProvider, users, events }) {
    this.authProvider = authProvider;
    this.users = users;
    this.events = events;
  }

  async login(email, password, { ip } = {}) {
    const normalized = String(email || '')
      .trim()
      .toLowerCase();
    let userId;
    try {
      userId = await this.authProvider.authenticate(normalized, password);
    } catch (err) {
      this.events.publish(EVENTS.USER_LOGIN_FAILED, { email: normalized, actor: { email: normalized, ip } });
      throw err instanceof AuthError ? err : new AuthError();
    }
    const user = await this.users.findById(userId);
    if (!user) throw new AuthError();
    if (!user.activo) throw new AuthError('Tu cuenta está desactivada. Contactá al administrador.');
    const updated = await this.users.update(user.id, { lastLoginAt: new Date().toISOString() });
    this.events.publish(EVENTS.USER_LOGIN, {
      actor: { id: user.id, email: user.email, ip },
      entity: 'usuario',
      entityId: user.id,
      detail: `Rol: ${user.role}`,
    });
    return updated || user;
  }

  async getUser(id) {
    return id ? this.users.findById(id) : null;
  }

  async changePassword(user, currentPassword, newPassword, { ip } = {}) {
    try {
      await this.authProvider.authenticate(user.email, currentPassword);
    } catch {
      throw new ValidationError('La contraseña actual no es correcta.', {
        actual: 'La contraseña actual no es correcta.',
      });
    }
    if (currentPassword === newPassword) {
      throw new ValidationError('La nueva contraseña debe ser distinta de la actual.', {
        nueva: 'Debe ser distinta de la actual.',
      });
    }
    await this.authProvider.updatePassword(user.id, newPassword);
    await this.users.update(user.id, { mustChangePassword: false });
    this.events.publish(EVENTS.USER_PASSWORD_CHANGED, {
      actor: { id: user.id, email: user.email, ip },
      entity: 'usuario',
      entityId: user.id,
    });
  }
}

module.exports = AuthService;
