'use strict';

const request = require('supertest');
const { makeApp } = require('../helpers/agent');

describe('Página de error', () => {
  let app;
  let container;
  beforeAll(async () => {
    ({ app, container } = makeApp());
    await container.ready;
  });

  it('un POST sin token CSRF muestra la página 403 (no falla al dibujarla)', async () => {
    const res = await request(app).post('/login').type('form').send({ email: 'x@y.com', password: 'z' });
    expect(res.status).toBe(403);
    expect(res.text).not.toMatch(/is not defined/);
    expect(res.text).toContain('Acceso denegado');
    expect(res.text).toContain('href="/login"');
  });

  it('un cuerpo JSON mal formado responde 400 sin romper la página de error', async () => {
    const res = await request(app).post('/login').set('Content-Type', 'application/json').send('{"a":');
    expect(res.status).toBeLessThan(500);
    expect(res.text).not.toMatch(/is not defined/);
  });

  it('la página 404 se dibuja sin sesión', async () => {
    const res = await request(app).get('/no-existe');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Página no encontrada');
  });
});
