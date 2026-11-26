'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureRemoteModels, remoteModelsEnabled, REMOTE_MODELS } = require('../../src/config/remoteModels');
const { toRow } = require('../../src/repositories/supabase/mappers');
const { generatePassword, parseArgs, patientEmail } = require('../../scripts/seed-supabase-real');

/** Cliente de Storage falso: sólo descarga los archivos presentes. */
function fakeClient(files, calls = []) {
  return {
    storage: {
      from: (bucket) => ({
        download: async (name) => {
          calls.push(`${bucket}/${name}`);
          if (!(name in files)) return { data: null, error: new Error('Object not found') };
          const buf = Buffer.from(files[name]);
          return { data: { arrayBuffer: async () => buf }, error: null };
        },
      }),
    },
  };
}

describe('modelos desde Supabase Storage', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termopie-modelos-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('sólo se activa con el driver supabase y fuera de las pruebas', () => {
    expect(remoteModelsEnabled({ DATA_DRIVER: 'supabase', NODE_ENV: 'production' })).toBe(true);
    expect(remoteModelsEnabled({ DATA_DRIVER: 'memory', NODE_ENV: 'production' })).toBe(false);
    expect(remoteModelsEnabled({ DATA_DRIVER: 'supabase', NODE_ENV: 'test' })).toBe(false);
    expect(remoteModelsEnabled({ DATA_DRIVER: 'supabase', MODELS_BUCKET: 'none' })).toBe(false);
  });

  it('descarga los archivos presentes, define sus variables y reporta los faltantes', async () => {
    const env = { ANGIOSOME_ATLAS: '/ya/definido.json' };
    const calls = [];
    const client = fakeClient({ 'forecast-zones.json': '{"a":1}', 'tci-reference.json': '{"miembros":[]}' }, calls);
    const out = await ensureRemoteModels({ client, env, cacheDir: tmp });
    expect(out.cargados.sort()).toEqual(['forecast-zones.json', 'tci-reference.json']);
    expect(out.omitidos).toEqual(['angiosome-atlas.json']);
    expect(out.faltantes.sort()).toEqual(['outcome-logreg.json', 'riskfactor-neuropatia-cnn.json']);
    expect(env.PRONOSTICO_MODELO).toBe(path.join(tmp, 'forecast-zones.json'));
    expect(env.TCI_REFERENCE_DIR).toBe(tmp);
    expect(env.ANGIOSOME_ATLAS).toBe('/ya/definido.json');
    expect(env.RIESGO_FACTOR_MODELO).toBeUndefined();
    expect(fs.readFileSync(path.join(tmp, 'forecast-zones.json'), 'utf8')).toBe('{"a":1}');
    expect(calls.every((c) => c.startsWith('modelos/'))).toBe(true);
    expect(calls).not.toContain('modelos/angiosome-atlas.json');

    // Un arranque posterior reutiliza la copia en caché sin volver a descargar.
    const calls2 = [];
    const env2 = {};
    await ensureRemoteModels({ client: fakeClient({}, calls2), env: env2, cacheDir: tmp });
    expect(env2.PRONOSTICO_MODELO).toBe(path.join(tmp, 'forecast-zones.json'));
    expect(calls2).not.toContain('modelos/forecast-zones.json');
  });

  it('cada modelo usa la variable que ya acepta su cargador', () => {
    expect(Object.fromEntries(REMOTE_MODELS.map((m) => [m.file, m.env]))).toMatchObject({
      'forecast-zones.json': 'PRONOSTICO_MODELO',
      'riskfactor-neuropatia-cnn.json': 'RIESGO_FACTOR_MODELO',
      'angiosome-atlas.json': 'ANGIOSOME_ATLAS',
      'tci-reference.json': 'TCI_REFERENCE_DIR',
    });
  });
});

describe('carga de datos reales en Supabase (utilidades)', () => {
  it('genera contraseñas fuertes y distintas', () => {
    const a = generatePassword(20);
    const b = generatePassword(20);
    expect(a).toHaveLength(20);
    expect(a).not.toBe(b);
    expect(a).toMatch(/[A-Z]/);
    expect(a).toMatch(/[a-z]/);
    expect(a).toMatch(/[0-9]/);
    expect(a).toMatch(/[^A-Za-z0-9]/);
  });

  it('los correos de pacientes usan un dominio reservado no entregable', () => {
    expect(patientEmail('P.HC901')).toBe('phc901@sin-acceso.invalid');
    expect(patientEmail('P.HC901')).not.toMatch(/pacientes\.local/);
  });

  it('interpreta las opciones', () => {
    expect(parseArgs(['--dry-run', '--rotate-staff=x.local'])).toMatchObject({
      dryRun: true,
      rotateStaff: 'x.local',
      purgeDemo: false,
    });
    expect(parseArgs(['--rotate-staff']).rotateStaff).toBeNull();
  });

  it('el mapper de Supabase guarda «neuropatía sin dato»', () => {
    expect(toRow('patients', { neuropatiaSinDato: true })).toEqual({ neuropatia_sin_dato: true });
  });
});
