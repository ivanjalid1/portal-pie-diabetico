'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { makeApp, loginAs } = require('../helpers/agent');
const { fakeIs2 } = require('../helpers/is2');
const { createApp } = require('../../src/app');
const { buildContainer } = require('../../src/container');
const { buildConfig } = require('../../src/config');
const { decodeThermal } = require('../../src/imaging/thermalArray');
const { writeNpy } = require('../../src/utils/npy');
const { is2Key } = require('../../src/services/ThermalViewerService');

/** Respuesta binaria de supertest como Buffer. */
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('Visor de termogramas en modo demo (sin fotos visibles)', () => {
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

  it('la página del estudio incluye el visor sin enlaces a fotos', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    const res = await agent.get(`/medico/estudios/${study.id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Termografía (visor)');
    expect(res.text).toContain(`/medico/estudios/${study.id}/visor/1/1/termica.bin`);
    expect(res.text).not.toMatch(/foto\.jpg/);
    expect(res.text).toContain('Fusión IR');
  });

  it('el médico tratante recibe la matriz TPV1 reconstruida del par demo', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    const res = await agent.get(`/medico/estudios/${study.id}/visor/1/1/termica.bin`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/octet-stream/);
    expect(res.headers['cache-control']).toMatch(/private/);
    const T = decodeThermal(res.body);
    expect(T.width).toBe(320);
    expect(T.height).toBe(240);
    const vals = Array.from(T.data).filter(Number.isFinite);
    expect(Math.min(...vals)).toBeGreaterThan(10);
    expect(Math.max(...vals)).toBeLessThan(45);
  });

  it('en demo no hay foto visible (404) aunque se la pida', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    expect((await agent.get(`/medico/estudios/${study.id}/visor/1/1/foto.jpg`)).status).toBe(404);
    expect(container.services.viewerService.visibleEnabled).toBe(false);
  });

  it('réplicas o tomas inexistentes dan 404', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    expect((await agent.get(`/medico/estudios/${study.id}/visor/1/2/termica.bin`)).status).toBe(404);
    expect((await agent.get(`/medico/estudios/${study.id}/visor/3/1/termica.bin`)).status).toBe(404);
  });

  it('control de acceso: anónimo, paciente, administrador y otro médico', async () => {
    const url = `/medico/estudios/${study.id}/visor/1/1/termica.bin`;
    const anon = await request(app).get(url);
    expect(anon.status).toBe(302);
    expect(anon.headers.location).toMatch(/^\/login/);
    for (const email of ['paciente@demo.com', 'admin@demo.com']) {
      const agent = await loginAs(app, email);
      expect((await agent.get(url)).status).toBe(403);
    }
    const agent = await loginAs(app, 'medico@demo.com');
    expect((await agent.get(`/medico/estudios/${ajeno.id}/visor/1/1/termica.bin`)).status).toBe(403);
    expect((await agent.get(`/medico/estudios/${ajeno.id}/visor/1/1/foto.jpg`)).status).toBe(403);
  });
});

describe('Visor en la herramienta de máscaras (local, con carpeta privada)', () => {
  const W = 320;
  const H = 240;
  let app;
  let key;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termopie-visor-'));
    const priv = path.join(dir, 'privado');
    const file = path.join(priv, 'P', 'IR_0001.IS2');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fakeIs2({ visible: true }));
    key = is2Key(priv, file);
    const cache = path.join(dir, 'ml', 'cache');
    const T = new Float32Array(W * H).fill(24);
    T.fill(31, 100 * W, 140 * W);
    const lab = new Uint8Array(W * H);
    lab.fill(1, 100 * W, 100 * W + 50);
    lab.fill(2, 120 * W, 120 * W + 50);
    writeNpy(path.join(cache, `${key}_t.npy`), T, [H, W]);
    writeNpy(path.join(cache, `${key}_cls.npy`), lab, [H, W]);
    fs.writeFileSync(
      path.join(cache, 'index.json'),
      JSON.stringify([{ key, codigo: 'P.HC999', toma: 1, rep: 0, calidad: 0.8, exportado: true }]),
    );
    const config = buildConfig({ ...process.env, NODE_ENV: 'test', DATA_DRIVER: 'memory' });
    const container = buildContainer({ config, overrides: { maskDir: dir, viewerPrivateDir: priv } });
    app = createApp(container);
    await container.ready;
  });

  it('el editor usa el visor y ofrece la foto; la foto y la matriz se sirven', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    const page = await agent.get(`/mascaras/${key}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('data-tv-ui');
    expect(page.text).toContain(`/mascaras/${key}/foto.jpg`);
    const bin = await agent.get(`/mascaras/${key}/termica.bin`).buffer(true).parse(binary);
    expect(bin.status).toBe(200);
    const T = decodeThermal(bin.body);
    expect(T.data[110 * W]).toBeCloseTo(31, 1);
    const foto = await agent.get(`/mascaras/${key}/foto.jpg`);
    expect(foto.status).toBe(200);
    expect(foto.headers['content-type']).toMatch(/image\/jpeg/);
    expect(foto.headers['cache-control']).toMatch(/no-store/);
  });

  it('el administrador también accede; el paciente no', async () => {
    const admin = await loginAs(app, 'admin@demo.com');
    expect((await admin.get(`/mascaras/${key}/foto.jpg`)).status).toBe(200);
    const paciente = await loginAs(app, 'paciente@demo.com');
    expect((await paciente.get(`/mascaras/${key}/foto.jpg`)).status).toBe(403);
    expect((await paciente.get(`/mascaras/${key}/termica.bin`)).status).toBe(403);
  });

  it('claves desconocidas dan 404', async () => {
    const agent = await loginAs(app, 'medico@demo.com');
    expect((await agent.get('/mascaras/ffffffffffffffff/foto.jpg')).status).toBe(404);
    expect((await agent.get('/mascaras/zz/termica.bin')).status).toBe(404);
  });
});
