'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../../src/app');
const { buildContainer } = require('../../src/container');
const { buildConfig } = require('../../src/config');
const { loginAs, csrfFrom } = require('../helpers/agent');
const { writeNpy, readNpy } = require('../../src/utils/npy');
const { MaskService, encodeRle, decodeRle } = require('../../src/services/MaskService');
const OutcomeLog = require('../../src/services/OutcomeLog');
const { DomainEventBus, EVENTS } = require('../../src/utils/eventBus');
const { COLUMNS } = require('../../src/utils/csv');

const W = 320;
const H = 240;
const KEY = '0123456789abcdef';

/** Carpeta data-local de prueba con una réplica exportada (temperatura, clásica, U-Net). */
function fixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termopie-ml-'));
  const cache = path.join(dir, 'ml', 'cache');
  const T = new Float32Array(W * H).fill(22);
  const lab = new Uint8Array(W * H);
  for (let y = 40; y < 200; y += 1) {
    for (let x = 40; x < 120; x += 1) {
      T[y * W + x] = 30;
      lab[y * W + x] = 1;
    }
    for (let x = 200; x < 280; x += 1) {
      T[y * W + x] = 30;
      lab[y * W + x] = 2;
    }
  }
  writeNpy(path.join(cache, `${KEY}_t.npy`), T, [H, W]);
  writeNpy(path.join(cache, `${KEY}_cls.npy`), lab, [H, W]);
  writeNpy(path.join(dir, 'ml', 'unet-masks', `${KEY}.npy`), lab, [H, W]);
  fs.writeFileSync(
    path.join(cache, 'index.json'),
    JSON.stringify([
      { key: KEY, codigo: 'P.HC999', toma: 1, rep: 0, calidad: 0.42, noValido: false, ok: true, exportado: true },
      { key: 'ffffffffffffffff', codigo: 'P.HC998', toma: 1, rep: 0, calidad: 0.9, exportado: true },
    ]),
  );
  return { dir, lab };
}

function appWith(overrides) {
  const config = buildConfig({ ...process.env, NODE_ENV: 'test', DATA_DRIVER: 'memory' });
  const container = buildContainer({ config, overrides });
  return { app: createApp(container), container };
}

describe('MaskService (corrección de máscaras, sólo local)', () => {
  test('RLE ida y vuelta y validación estricta', () => {
    const lab = new Uint8Array(W * H);
    lab.fill(1, 1000, 5000);
    lab.fill(2, 9000, 9100);
    expect(decodeRle(encodeRle(lab))).toEqual(lab);
    expect(() => decodeRle('3:76800')).toThrow();
    expect(() => decodeRle('0:10')).toThrow();
    expect(() => decodeRle('0:76801')).toThrow();
    expect(() => decodeRle(null)).toThrow();
  });

  test('lista primero las de menor calidad, entrega imagen y máscaras, guarda la corrección', () => {
    const { dir, lab } = fixtureDir();
    const svc = new MaskService({ dir });
    expect(svc.enabled).toBe(true);
    const l = svc.list({ filtro: 'todas' });
    expect(l.total).toBe(2);
    expect(l.items[0].key).toBe(KEY);
    expect(l.items[0].unet).toBe(true);
    const png = svc.imagePng(KEY);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const m = svc.masks(KEY);
    expect(m.base).toBe('unet');
    expect(decodeRle(m.unet)).toEqual(lab);
    const edit = lab.slice();
    edit.fill(0, 40 * W, 60 * W);
    const meta = svc.save(KEY, encodeRle(edit), { id: 'u1', role: 'medico', email: 'no@guardar' }, { origen: 'unet' });
    expect(meta.rol).toBe('medico');
    expect(JSON.stringify(meta)).not.toContain('no@guardar');
    expect(readNpy(path.join(dir, 'ml', 'corrected-masks', `${KEY}.npy`)).data).toEqual(edit);
    expect(svc.masks(KEY).base).toBe('corregida');
    expect(svc.list({ filtro: 'corregidas' }).items.map((e) => e.key)).toEqual([KEY]);
    expect(() => svc.save(KEY, encodeRle(new Uint8Array(W * H)), {})).toThrow(/50 píxeles/);
    expect(() => svc.masks('../../etc/passwd')).toThrow();
    expect(() => svc.masks('aaaaaaaaaaaaaaaa')).toThrow();
  });

  test('sin carpeta queda deshabilitada', () => {
    expect(new MaskService({ dir: null }).enabled).toBe(false);
  });

  describe('rutas /mascaras', () => {
    let app;
    let dir;
    beforeAll(async () => {
      ({ dir } = fixtureDir());
      let container;
      ({ app, container } = appWith({ maskDir: dir }));
      await container.ready;
    });

    it('médico y administrador acceden; el paciente no', async () => {
      const medico = await loginAs(app, 'medico@demo.com');
      const list = await medico.get('/mascaras');
      expect(list.status).toBe(200);
      expect(list.text).toContain('Corrección de máscaras');
      expect(list.text).toContain('P.HC999');
      expect(list.text).toContain('href="/mascaras"');
      const ed = await medico.get(`/mascaras/${KEY}`);
      expect(ed.status).toBe(200);
      expect(ed.text).toContain('data-mask-editor');
      expect((await medico.get(`/mascaras/${KEY}/imagen.png`)).type).toBe('image/png');
      const js = await medico.get(`/mascaras/${KEY}/mascaras.json`);
      expect(js.body.base).toBe('unet');
      const admin = await loginAs(app, 'admin@demo.com');
      expect((await admin.get('/mascaras')).status).toBe(200);
      const pac = await loginAs(app, 'paciente@demo.com');
      expect((await pac.get('/mascaras')).status).toBe(403);
    });

    it('guarda por fetch con CSRF y responde JSON ante errores', async () => {
      const medico = await loginAs(app, 'medico@demo.com');
      const csrf = await csrfFrom(medico, `/mascaras/${KEY}`);
      const { body } = await medico.get(`/mascaras/${KEY}/mascaras.json`);
      const ok = await medico
        .post(`/mascaras/${KEY}`)
        .set('X-CSRF-Token', csrf)
        .send({ rle: body.unet, origen: 'unet' });
      expect(ok.status).toBe(200);
      expect(ok.body.ok).toBe(true);
      const bad = await medico.post(`/mascaras/${KEY}`).set('X-CSRF-Token', csrf).send({ rle: '0:5' });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/inválida/);
      const noCsrf = await medico.post(`/mascaras/${KEY}`).send({ rle: body.unet });
      expect(noCsrf.status).toBe(403);
    });

    it('sin carpeta local la herramienta no existe (404) y no aparece en el menú', async () => {
      const { app: app2, container } = appWith({ maskDir: null });
      await container.ready;
      const medico = await loginAs(app2, 'medico@demo.com');
      expect((await medico.get('/mascaras')).status).toBe(404);
      expect((await medico.get('/medico')).text).not.toContain('href="/mascaras"');
    });
  });
});

describe('Desenlace real: registro persistente y exportación', () => {
  test('OutcomeLog guarda lo mínimo (sin notas) y lo vuelve a aplicar al arrancar', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termopie-out-'));
    const file = path.join(dir, 'outcomes', 'outcomes.json');
    const store = new Map([['p1', { id: 'p1', codigo: 'P.HC001', generoLesion: null }]]);
    const patients = {
      findById: async (id) => store.get(id) || null,
      findByCodigo: async (c) => [...store.values()].find((p) => p.codigo === c) || null,
      update: async (id, patch) => store.set(id, { ...store.get(id), ...patch }),
    };
    const events = new DomainEventBus();
    const log = new OutcomeLog({ file, patients, events }).subscribe();
    store.set('p1', {
      ...store.get('p1'),
      generoLesion: true,
      lesionFecha: '2026-10-01',
      lesionPie: 'izquierdo',
      lesionRoi: 'talon',
      lesionNotas: 'texto libre',
    });
    events.publish(EVENTS.OUTCOME_RECORDED, { entityId: 'p1' });
    await new Promise((r) => setImmediate(r));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.registros).toEqual([
      expect.objectContaining({
        codigo: 'P.HC001',
        generoLesion: true,
        fecha: '2026-10-01',
        pie: 'izquierdo',
        zona: 'talon',
      }),
    ]);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('texto libre');
    // «Reinicio»: el paciente vuelve sin desenlace y se le reaplica.
    store.set('p1', { id: 'p1', codigo: 'P.HC001', generoLesion: null });
    expect(await log.applyAll()).toBe(1);
    expect(store.get('p1').generoLesion).toBe(true);
    expect(store.get('p1').lesionRoi).toBe('talon');
  });

  test('el desenlace registrado en el portal queda en el archivo local', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termopie-out-'));
    const file = path.join(dir, 'outcomes.json');
    const { app, container } = appWith({ outcomeFile: file });
    await container.ready;
    const medico = await loginAs(app, 'medico@demo.com');
    const patient = (
      await container.repos.patients.listByMedico((await container.repos.users.findByEmail('medico@demo.com')).id)
    )[0];
    const csrf = await csrfFrom(medico, `/medico/pacientes/${patient.id}`);
    const res = await medico
      .post(`/medico/pacientes/${patient.id}/desenlace`)
      .type('form')
      .send({ _csrf: csrf, generoLesion: 'no', fecha: '2026-01-15' });
    expect(res.status).toBe(303);
    await new Promise((r) => setTimeout(r, 20));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.registros[0]).toEqual(expect.objectContaining({ codigo: patient.codigo, generoLesion: false }));
  });

  test('el CSV exporta el desenlace detallado y el patrón de la base pública, no la probabilidad HbA1c', () => {
    const heads = COLUMNS.map(([h]) => h);
    expect(heads).toEqual(expect.arrayContaining(['GENERÓ LESIÓN', 'FECHA LESIÓN', 'PIE LESIÓN', 'ZONA LESIÓN']));
    expect(heads).toContain('PATRON PIE DIABETICO (%) BASE PUBLICA');
    expect(heads.some((h) => /PROBABILIDAD/.test(h))).toBe(false);
  });
});
