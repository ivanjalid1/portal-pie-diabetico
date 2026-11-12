'use strict';

const { requireAuth, requireRole, enforcePasswordChange } = require('../../src/middlewares/auth');
const { ForbiddenError } = require('../../src/utils/errors');

const res = () => {
  const r = { redirect: jest.fn(), status: jest.fn(() => r), render: jest.fn() };
  return r;
};

describe('Cadena de middlewares de autorización', () => {
  it('requireAuth redirige al login conservando el destino', () => {
    const r = res();
    const next = jest.fn();
    requireAuth({ method: 'GET', originalUrl: '/medico/pacientes' }, r, next);
    expect(r.redirect).toHaveBeenCalledWith('/login?next=%2Fmedico%2Fpacientes');
    expect(next).not.toHaveBeenCalled();
  });

  it('requireAuth deja pasar si hay usuario', () => {
    const next = jest.fn();
    requireAuth({ user: { id: '1' } }, res(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it.each([
    ['admin', ['admin'], true],
    ['medico', ['admin'], false],
    ['paciente', ['medico'], false],
    ['medico', ['medico', 'admin'], true],
  ])('rol %s con permitidos %j → acceso %s', (role, allowed, ok) => {
    const next = jest.fn();
    requireRole(...allowed)({ user: { role } }, res(), next);
    const arg = next.mock.calls[0][0];
    if (ok) expect(arg).toBeUndefined();
    else expect(arg).toBeInstanceOf(ForbiddenError);
  });

  it('obliga a cambiar la contraseña temporal antes de navegar', () => {
    const r = res();
    const next = jest.fn();
    enforcePasswordChange({ user: { mustChangePassword: true }, path: '/paciente', method: 'GET' }, r, next);
    expect(r.redirect).toHaveBeenCalledWith('/cuenta/password');
    const next2 = jest.fn();
    enforcePasswordChange(
      { user: { mustChangePassword: true }, path: '/cuenta/password', method: 'GET' },
      res(),
      next2,
    );
    expect(next2).toHaveBeenCalled();
  });
});
