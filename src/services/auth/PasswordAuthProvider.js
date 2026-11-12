'use strict';

const bcrypt = require('bcryptjs');
const AuthProvider = require('./AuthProvider');
const { AuthError } = require('../../utils/errors');
const { uuid } = require('../../utils/random');

/** Hash constante para igualar el tiempo de respuesta cuando el usuario no existe. */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 4);

/** Estrategia de correo + contraseña con hashes bcrypt (driver memory). */
class PasswordAuthProvider extends AuthProvider {
  constructor({ users, credentials, rounds = 10 }) {
    super();
    this.users = users;
    this.credentials = credentials;
    this.rounds = rounds;
  }

  get id() {
    return 'password';
  }

  async authenticate(email, password) {
    const user = await this.users.findByEmail(email);
    const hash = (user && this.credentials.get(user.id)) || DUMMY_HASH;
    const ok = await bcrypt.compare(String(password), hash);
    if (!user || !ok) throw new AuthError();
    return user.id;
  }

  async createIdentity(email, password) {
    const existing = await this.users.findByEmail(email);
    if (existing) throw new AuthError('Ya existe una cuenta con ese correo.');
    const id = uuid();
    this.credentials.set(id, await bcrypt.hash(String(password), this.rounds));
    return id;
  }

  async updatePassword(userId, newPassword) {
    this.credentials.set(userId, await bcrypt.hash(String(newPassword), this.rounds));
  }

  async deleteIdentity(userId) {
    this.credentials.delete(userId);
  }
}

module.exports = PasswordAuthProvider;
