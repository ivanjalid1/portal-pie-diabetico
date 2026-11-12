'use strict';

const request = require('supertest');
const { makeApp, loginAs, extractCsrf } = require('../helpers/agent');

describe('Autenticación y sesión', () => {
  let app;
  beforeAll(() => {
    ({ app } = makeApp());
  });

  it('la landing y el login son públicos y muestran las cuentas demo', async () => {
    const home = await request(app).get('/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('Procesamiento de imágenes y análisis punto a punto');
    const login = await request(app).get('/login');
    expect(login.status).toBe(200);
    expect(login.text).toContain('Cuentas demo');
    expect(login.text).toContain('medico@demo.com');
  });

  it('envía cabeceras de seguridad (helmet) y cookie httpOnly', async () => {
    const res = await request(app).get('/login');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const agent = await loginAs(app, 'medico@demo.com');
    const cookie = agent.lastLogin.headers['set-cookie'].join(';');
    expect(cookie).toMatch(/httponly/i);
  });

  it.each([
    ['admin@demo.com', '/admin'],
    ['medico@demo.com', '/medico'],
    ['paciente@demo.com', '/paciente'],
  ])('%s ingresa y es redirigido a %s', async (email, home) => {
    const agent = await loginAs(app, email);
    expect(agent.lastLogin.status).toBe(303);
    expect(agent.lastLogin.headers.location).toBe(home);
    const page = await agent.get(home);
    expect(page.status).toBe(200);
  });

  it('rechaza una contraseña incorrecta con mensaje genérico', async () => {
    const agent = await loginAs(app, 'medico@demo.com', 'incorrecta');
    expect(agent.lastLogin.headers.location).toBe('/login');
    const page = await agent.get('/login');
    expect(page.text).toContain('Correo o contraseña incorrectos');
  });

  it('rechaza un POST sin token CSRF', async () => {
    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ email: 'medico@demo.com', password: 'Demo1234!' });
    expect(res.status).toBe(403);
  });

  it('cerrar sesión invalida el acceso', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    const page = await agent.get('/medico');
    const out = await agent
      .post('/logout')
      .type('form')
      .send({ _csrf: extractCsrf(page.text) });
    expect(out.headers.location).toBe('/login');
    const again = await agent.get('/medico');
    expect(again.status).toBe(302);
    expect(again.headers.location).toMatch(/^\/login/);
  });

  it('responde 404 con página propia', async () => {
    const res = await request(app).get('/no-existe');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Página no encontrada');
  });
});
