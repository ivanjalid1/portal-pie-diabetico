'use strict';

/**
 * Interfaz de proveedor de identidad (patrón Strategy).
 *
 * Hoy existen dos estrategias de correo + contraseña:
 *  - `PasswordAuthProvider` (driver memory): hashes bcrypt en memoria.
 *  - `SupabaseAuthProvider` (driver supabase): Supabase Auth.
 *
 * Para incorporar "Iniciar sesión con Google" se agrega una estrategia OAuth
 * (ver `GoogleOAuthProvider`) que implemente `getAuthorizationUrl()` y
 * `handleCallback()`; el resto del sistema sigue trabajando con el `userId`.
 */
class AuthProvider {
  /** Identificador de la estrategia (p. ej. 'password', 'supabase', 'google'). */
  get id() {
    throw new Error('AuthProvider.id no implementado');
  }

  /** @returns {Promise<string>} userId si las credenciales son válidas; lanza AuthError si no. */
  async authenticate(_email, _password) {
    throw new Error('AuthProvider.authenticate no implementado');
  }

  /** Crea la identidad y devuelve el id que usará el perfil. */
  async createIdentity(_email, _password, _metadata) {
    throw new Error('AuthProvider.createIdentity no implementado');
  }

  async updatePassword(_userId, _newPassword) {
    throw new Error('AuthProvider.updatePassword no implementado');
  }

  /** Compensación si falla la creación del perfil asociado. */
  async deleteIdentity(_userId) {
    throw new Error('AuthProvider.deleteIdentity no implementado');
  }

  /** Indica si la estrategia usa redirección (OAuth) en lugar de formulario. */
  get supportsRedirect() {
    return false;
  }
}

module.exports = AuthProvider;
