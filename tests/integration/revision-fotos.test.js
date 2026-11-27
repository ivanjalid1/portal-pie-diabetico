'use strict';

const request = require('supertest');
const { makeApp, loginAs, csrfFrom } = require('../helpers/agent');

describe('Revisión de fotos (sección propia /revision)', () => {
  let app;
  let container;
  let study;
  let ajeno;
  beforeAll(async () => {
    ({ app, container } = makeApp());
    await container.ready;
    const medico = await container.repos.users.findByEmail('medico@demo.com');
    [study] = await container.repos.studies.listByMedico(medico.id);
    const otro = await container.repos.users.findByEmail('medico2@demo.com');
    [ajeno] = await container.repos.studies.listByMedico(otro.id);
  });

  const url = (id = study.id, toma = 1, rep = 1, file = 'revision') =>
    `/revision/estudios/${id}/visor/${toma}/${rep}/${file}`;

  it('aparece en el menú del médico y del administrador, no en el del paciente', async () => {
    for (const [email, home] of [
      ['medico@demo.com', '/medico'],
      ['admin@demo.com', '/admin'],
    ]) {
      const agent = await loginAs(app, email);
      const res = await agent.get(home);
      expect(res.text).toMatch(/href="\/revision"[^>]*>[\s\S]*?Revisión de fotos/);
    }
    const pac = await loginAs(app, 'paciente@demo.com');
    const res = await pac.get('/paciente');
    expect(res.text).not.toContain('Revisión de fotos');
  });

  it('el médico ve la grilla de sus fotos con el progreso y los filtros', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    const res = await agent.get('/revision?estado=todas');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(
      /<strong class="num" data-rv-revisadas>0<\/strong> de <span class="num" data-rv-total>\d+<\/span> revisadas/,
    );
    for (const f of ['Falta revisar', 'Aprobadas', 'Rechazadas', 'Calidad baja', 'Con avisos automáticos', 'Todas']) {
      expect(res.text).toContain(f);
    }
    expect(res.text).toContain(`action="${url()}"`);
    expect(res.text).toContain(`src="${url(study.id, 1, 1, 'miniatura.png')}"`);
    expect(res.text).toMatch(/value="pendiente"[^>]*checked/);
    expect(res.text).toContain(`href="/medico/estudios/${study.id}?foto=1-1#visor"`);
    expect(res.text).not.toContain(`/revision/estudios/${ajeno.id}/`);
  });

  it('el administrador ve las fotos de todos los médicos', async () => {
    const agent = await loginAs(app, 'admin@demo.com');
    const res = await agent.get('/revision?estado=todas');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`/revision/estudios/${study.id}/`);
    expect(res.text).toContain(`/revision/estudios/${ajeno.id}/`);
  });

  it('el médico guarda una revisión (JSON) y la página muestra quién y cuándo', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    const csrf = await csrfFrom(agent, '/revision');
    const res = await agent
      .post(url())
      .set('Accept', 'application/json')
      .set('X-CSRF-Token', csrf)
      .type('form')
      .send({ estado: 'rechazado', comentario: 'Pie fuera de foco' });
    expect(res.status).toBe(200);
    expect(res.body.revision).toMatchObject({ toma: 1, replica: 1, estado: 'rechazado', etiqueta: 'Rechazado' });
    const medico = await container.repos.users.findByEmail('medico@demo.com');
    expect(res.body.revision.guardado.startsWith(`Guardado por ${medico.nombreCompleto} · `)).toBe(true);
    const page = await agent.get('/revision?estado=rechazado');
    expect(page.text).toContain('Pie fuera de foco');
    expect(page.text).toContain(`Guardado por ${medico.nombreCompleto} · `);
    expect(page.text).toMatch(/Guardado por [^<]+ · \d{2}\/\d{2}\/\d{4}/);
    expect(page.text).toMatch(/data-rv-revisadas>1</);
    // Vuelve a «Falta revisar» con comentario vacío.
    const back = await agent
      .post(url())
      .set('Accept', 'application/json')
      .set('X-CSRF-Token', csrf)
      .type('form')
      .send({ estado: 'pendiente', comentario: '' });
    expect(back.body.revision).toMatchObject({ estado: 'pendiente', comentario: '' });
  });

  it('sin JS guarda y vuelve a la página de revisión (sólo rutas /revision)', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    const csrf = await csrfFrom(agent, '/revision');
    const ok = await agent
      .post(url(study.id, 2, 1))
      .type('form')
      .send({ _csrf: csrf, estado: 'aprobado', volver: '/revision?estado=todas#foto-x' });
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe('/revision?estado=todas#foto-x');
    const evil = await agent
      .post(url(study.id, 2, 1))
      .type('form')
      .send({ _csrf: csrf, estado: 'aprobado', volver: 'https://evil.example/' });
    expect(evil.headers.location).toMatch(/^\/revision\//);
  });

  it('el administrador puede revisar y ver el visor de sólo lectura', async () => {
    const agent = await loginAs(app, 'admin@demo.com');
    const csrf = await csrfFrom(agent, '/revision');
    const res = await agent
      .post(url(ajeno.id, 1, 1))
      .set('Accept', 'application/json')
      .set('X-CSRF-Token', csrf)
      .type('form')
      .send({ estado: 'aprobado', comentario: '' });
    expect(res.status).toBe(200);
    expect(res.body.revision.guardado).toMatch(/^Guardado por /);
    const visor = await agent.get(`/revision/estudios/${ajeno.id}?foto=1-1`);
    expect(visor.status).toBe(200);
    expect(visor.text).toContain('data-tv');
    expect(visor.text).toContain(`/revision/estudios/${ajeno.id}/visor/1/1/termica.bin`);
    expect(visor.text).not.toContain('data-ir-form');
    const bin = await agent.get(url(ajeno.id, 1, 1, 'termica.bin'));
    expect(bin.status).toBe(200);
  });

  it('miniatura PNG de la térmica', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    const res = await agent.get(url(study.id, 1, 1, 'miniatura.png')).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['cache-control']).toMatch(/private/);
    const other = await agent.get(url(ajeno.id, 1, 1, 'miniatura.png'));
    expect(other.status).toBe(403);
  });

  it('sin token CSRF se rechaza; valida estado y comentario; foto inexistente 404', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    expect((await agent.post(url()).type('form').send({ estado: 'aprobado' })).status).toBe(403);
    const csrf = await csrfFrom(agent, '/revision');
    const largo = await agent
      .post(url())
      .set('Accept', 'application/json')
      .type('form')
      .send({ _csrf: csrf, estado: 'aprobado', comentario: 'x'.repeat(1001) });
    expect(largo.status).toBe(422);
    const bad = await agent
      .post(url())
      .set('Accept', 'application/json')
      .type('form')
      .send({ _csrf: csrf, estado: 'quizas' });
    expect(bad.status).toBe(422);
    const nf = await agent
      .post(url(study.id, 1, 3))
      .type('form')
      .send({ _csrf: csrf, estado: 'aprobado' });
    expect(nf.status).toBe(404);
  });

  it('control de acceso: anónimo, paciente y otro médico', async () => {
    const anon = await request(app).get('/revision');
    expect(anon.status).toBe(302);
    expect(anon.headers.location).toMatch(/^\/login/);
    const anonPost = await request(app).post(url()).type('form').send({ estado: 'aprobado' });
    expect([302, 401, 403]).toContain(anonPost.status);

    const pac = await loginAs(app, 'paciente@demo.com');
    expect((await pac.get('/revision')).status).toBe(403);
    expect((await pac.get(`/revision/estudios/${study.id}`)).status).toBe(403);
    expect((await pac.get(url(study.id, 1, 1, 'miniatura.png'))).status).toBe(403);
    const pcsrf = await csrfFrom(pac, '/cuenta/password');
    expect((await pac.post(url()).type('form').send({ _csrf: pcsrf, estado: 'aprobado' })).status).toBe(403);

    const med = await loginAs(app, 'medico@demo.com');
    const csrf = await csrfFrom(med, '/revision');
    const before = await container.repos.imageReviews.listByStudy(ajeno.id);
    const res = await med
      .post(url(ajeno.id, 1, 2))
      .type('form')
      .send({ _csrf: csrf, estado: 'aprobado' });
    expect(res.status).toBe(403);
    expect(await container.repos.imageReviews.listByStudy(ajeno.id)).toEqual(before);
    expect((await med.get(`/revision/estudios/${ajeno.id}`)).status).toBe(403);
  });

  it('la página del estudio ya no tiene controles de revisión', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    const res = await agent.get(`/medico/estudios/${study.id}?foto=2-1`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-tv-rep-inicial="1"');
    expect(res.text).not.toContain('Revisión de las fotos');
    expect(res.text).not.toContain('data-ir-');
    expect(res.text).not.toContain('data-rv');
    const old = await agent.post(`/medico/estudios/${study.id}/visor/1/1/revision`).type('form').send({});
    expect([403, 404]).toContain(old.status);
  });

  it('el paciente no ve la revisión en su estudio', async () => {
    const paciente = await container.repos.users.findByEmail('paciente@demo.com');
    const patient = await container.repos.patients.findByUserId(paciente.id);
    const [propio] = await container.repos.studies.listByPatient(patient.id);
    const agent = await loginAs(app, 'paciente@demo.com');
    const res = await agent.get(`/paciente/estudios/${propio.id}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Revisión de fotos');
    expect(res.text).not.toContain('/revision');
  });
});
