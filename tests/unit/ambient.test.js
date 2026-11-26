'use strict';

const zlib = require('node:zlib');
const { ambienteDeToma, fueraDeProtocolo, AJUSTE_AMBIENTE } = require('../../src/imaging/ambient');
const { numTemp, numRh, ratio, distanceToMask } = require('../../scripts/precompute-ambiente');
const { camposAmbiente } = require('../../src/seed/realData');
const { ambienteToma, payload } = require('../../src/utils/pointwiseView');
const { analyzePointwise } = require('../../src/services/predictors/pointwiseAnalysis');
const { encodeGrid, decodeGrid, GRID } = require('../../src/imaging/pointwise');
const { protocolRanges } = require('../../src/config/settings');
const { ThermalViewerService, REMOTE } = require('../../src/services/ThermalViewerService');
const { encodeThermal, decodeThermal } = require('../../src/imaging/thermalArray');

const PR = protocolRanges();

/** Grilla canónica constante (ambos pies iguales: ΔT = 0). */
const grid = (v) => encodeGrid(new Float32Array(GRID.w * GRID.h).fill(v));

describe('Ambiente de la sala', () => {
  test('ajuste de temperaturas absolutas: −0,45 °C por °C sobre 22 °C', () => {
    expect(AJUSTE_AMBIENTE).toEqual({ pendiente: 0.45, referenciaC: 22 });
    expect(ambienteDeToma({ tempC: 24, humedad: 50, origen: 'medida' }).ajusteC).toBeCloseTo(-0.9, 5);
    expect(ambienteDeToma({ tempC: 20 }).ajusteC).toBeCloseTo(0.9, 5);
    const est = ambienteDeToma({ tempC: 21.5, origen: 'estimada' });
    expect(est.origen).toBe('estimada');
    expect(est.errorC).toBe(0.7);
    expect(ambienteDeToma({ tempC: null, humedad: null })).toBeNull();
    expect(ambienteDeToma({ humedad: 55 }).ajusteC).toBeNull();
  });

  test('fuera de protocolo con los rangos de Configuración (21–24 °C, 40–70 %)', () => {
    expect(fueraDeProtocolo({ tempC: 22, humedad: 55 }, PR).alguno).toBe(false);
    expect(fueraDeProtocolo({ tempC: 20.5, humedad: 55 }, PR)).toMatchObject({ temp: true, hum: false });
    expect(fueraDeProtocolo({ tempC: 22, humedad: 35 }, PR)).toMatchObject({ temp: false, hum: true });
    expect(fueraDeProtocolo({ tempC: null, humedad: null }, PR).alguno).toBe(false);
  });

  test('texto por toma: medida, estimada y sin registro', () => {
    expect(ambienteToma({ tempC: 22.1, humedad: 55, origen: 'medida' }, PR).texto).toBe('Sala 22,1 °C · HR 55 %');
    const e = ambienteToma({ tempC: 21.5, humedad: null, origen: 'estimada', errorC: 0.7 }, PR);
    expect(e.texto).toBe('Sala ≈21,5 °C');
    expect(e.origen).toBe('estimada');
    expect(ambienteToma(null, PR).texto).toBe('Sin registro de la sala');
  });

  test('el estudio guarda sólo el ambiente medido', () => {
    const amb = { 1: { tempC: 22, humedad: 50, origen: 'medida' }, 2: { tempC: 21, origen: 'estimada' } };
    expect(camposAmbiente(amb, true)).toEqual({
      tempAmbienteToma1: 22,
      humedadRelativaToma1: 50,
      tempAmbiente: null,
      humedadRelativa: null,
    });
    expect(camposAmbiente({}, false).tempAmbienteToma1).toBeNull();
  });

  test('el análisis ajusta la mediana absoluta y deja ΔT intacto', () => {
    const base = { izq: grid(30), der: grid(30) };
    const sin = analyzePointwise({ toma1: base }, {});
    const con = analyzePointwise({ toma1: { ...base, ambiente: { tempC: 24, origen: 'medida' } } }, {});
    const t = con.tomas[0];
    expect(t.ambiente.ajusteC).toBeCloseTo(-0.9, 5);
    expect(t.absoluta.medianaC).toBe(30);
    expect(t.absoluta.medianaAjustadaC).toBeCloseTo(29.1, 5);
    expect(t.metricas).toEqual(sin.tomas[0].metricas);
    expect(sin.tomas[0].absoluta.medianaAjustadaC).toBeNull();
  });

  test('los mapas absolutos se muestran ajustados (constante por toma)', () => {
    const a = { puntual: analyzePointwise({ toma1: { izq: grid(30), der: grid(30), ambiente: { tempC: 20 } } }, {}) };
    const p = payload(a);
    expect(decodeGrid(p.tomas[0].izq)[0]).toBeCloseTo(30.9, 1);
  });

  test('lectura de la planilla y estimador por el fondo', () => {
    expect(numTemp('23,5°')).toBeCloseTo(23.5);
    expect(numTemp(21)).toBe(21);
    expect(numTemp('hola')).toBeNull();
    expect(numRh(0.65)).toBeCloseTo(65);
    expect(numRh(65)).toBeNull();
    expect(ratio('TERMOGRAFIA', 'TERMOGRAPIA')).toBeGreaterThanOrEqual(0.8);
    const m = new Uint8Array(25);
    m[12] = 1;
    const d = distanceToMask(m, 5, 5);
    expect(d[12]).toBe(0);
    expect(d[13]).toBe(1);
    expect(d[0]).toBeCloseTo(2 * Math.SQRT2, 5);
  });
});

describe('Visor en producción (manifiesto en el almacenamiento privado)', () => {
  const study = {
    id: 's1',
    patientId: 'p1',
    image: (slot) => (slot === 'toma1' ? { slot, storagePath: 'p1/s1/toma1.png', mime: 'image/png' } : null),
  };
  const files = new Map();
  const repo = { read: async (k) => files.get(k) || null };
  const T = encodeThermal({ width: 2, height: 1, data: Float32Array.from([30, 31]) });
  files.set(
    REMOTE.manifest(study),
    Buffer.from(JSON.stringify({ tomas: [{ toma: 1, reps: [{ rep: 1, mejor: true, foto: true }, { rep: 2 }] }] })),
  );
  files.set(REMOTE.thermal(study, 1, 1), zlib.gzipSync(T));
  files.set(REMOTE.visible(study, 1, 1), Buffer.from([0xff, 0xd8, 0xff]));

  test('las rutas no empiezan con el id del paciente (fuera del alcance de las políticas del cliente)', () => {
    for (const k of [REMOTE.manifest(study), REMOTE.thermal(study, 1, 1), REMOTE.visible(study, 1, 1)]) {
      expect(k.startsWith('p1/')).toBe(false);
    }
  });

  test('fuentes, matriz y foto desde el manifiesto', async () => {
    const svc = new ThermalViewerService({ files: repo });
    const src = await svc.sources(study, { codigo: 'P.HC999' });
    expect(src).toHaveLength(1);
    expect(src[0].reps.map((r) => r.foto)).toEqual([true, false]);
    expect(decodeThermal(await svc.thermal(study, null, 1, 1)).data[1]).toBeCloseTo(31, 2);
    expect((await svc.visible(study, null, 1, 1))[0]).toBe(0xff);
    await expect(svc.visible(study, null, 1, 2)).rejects.toThrow();
    await expect(svc.thermal(study, null, 1, 3)).rejects.toThrow();
  });
});
