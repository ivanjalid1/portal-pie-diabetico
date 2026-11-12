'use strict';

/** Errores de dominio con código HTTP asociado. */
class AppError extends Error {
  constructor(message, status = 500, code = 'error') {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
  }
}

class NotFoundError extends AppError {
  constructor(message = 'El recurso solicitado no existe.') {
    super(message, 404, 'not_found');
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'No tenés permisos para acceder a este recurso.') {
    super(message, 403, 'forbidden');
  }
}

class ValidationError extends AppError {
  constructor(message = 'Revisá los datos ingresados.', fields = {}) {
    super(message, 422, 'validation');
    this.fields = fields;
  }
}

class ConflictError extends AppError {
  constructor(message) {
    super(message, 409, 'conflict');
  }
}

class AuthError extends AppError {
  constructor(message = 'Correo o contraseña incorrectos.') {
    super(message, 401, 'auth');
  }
}

module.exports = { AppError, NotFoundError, ForbiddenError, ValidationError, ConflictError, AuthError };
