'use strict';

const AuthProvider = require('./AuthProvider');

/**
 * Estrategia futura: inicio de sesión con Google (OAuth 2.0 / OIDC).
 *
 * Con Supabase se implementaría con `supabase.auth.signInWithOAuth({ provider: 'google' })`
 * (flujo PKCE) y un endpoint `/auth/callback` que intercambie el código por la
 * sesión (`exchangeCodeForSession`). El perfil se vincula por correo: un
 * paciente registrado por su médico con su Gmail podrá ingresar sin contraseña.
 *
 * No está habilitada en esta versión; se deja el contrato para la extensión.
 */
class GoogleOAuthProvider extends AuthProvider {
  get id() {
    return 'google';
  }

  get supportsRedirect() {
    return true;
  }

  getAuthorizationUrl(_redirectTo) {
    throw new Error('Inicio de sesión con Google no habilitado todavía.');
  }

  async handleCallback(_code) {
    throw new Error('Inicio de sesión con Google no habilitado todavía.');
  }

  async authenticate() {
    throw new Error('GoogleOAuthProvider no admite contraseña.');
  }
}

module.exports = GoogleOAuthProvider;
