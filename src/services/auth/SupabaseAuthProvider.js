'use strict';

const AuthProvider = require('./AuthProvider');
const { AuthError, ConflictError } = require('../../utils/errors');

/** Estrategia de correo + contraseña delegada en Supabase Auth (GoTrue). */
class SupabaseAuthProvider extends AuthProvider {
  constructor({ clients }) {
    super();
    this.clients = clients;
  }

  get id() {
    return 'supabase';
  }

  async authenticate(email, password) {
    const anon = this.clients.createAnon();
    const { data, error } = await anon.auth.signInWithPassword({ email, password: String(password) });
    if (error || !data?.user) throw new AuthError();
    // La sesión de Supabase no se usa: la aplicación maneja su propia cookie firmada.
    await anon.auth.signOut().catch(() => {});
    return data.user.id;
  }

  async createIdentity(email, password, metadata = {}) {
    const { data, error } = await this.clients.admin.auth.admin.createUser({
      email,
      password: String(password),
      email_confirm: true,
      user_metadata: metadata,
    });
    if (error) {
      if (/already|registered|exists/i.test(error.message)) {
        throw new ConflictError('Ya existe una cuenta con ese correo electrónico.');
      }
      throw new Error(`Supabase Auth: ${error.message}`);
    }
    return data.user.id;
  }

  async updatePassword(userId, newPassword) {
    const { error } = await this.clients.admin.auth.admin.updateUserById(userId, { password: String(newPassword) });
    if (error) throw new Error(`Supabase Auth: ${error.message}`);
  }

  async deleteIdentity(userId) {
    const { error } = await this.clients.admin.auth.admin.deleteUser(userId);
    if (error) throw new Error(`Supabase Auth: ${error.message}`);
  }
}

module.exports = SupabaseAuthProvider;
