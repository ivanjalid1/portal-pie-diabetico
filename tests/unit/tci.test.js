'use strict';

const { GRID, encodeGrid, decodeGrid } = require('../../src/imaging/pointwise');
const { buildReference, computeTci, claseTci, cellAngiosoma, ANGIOSOMAS } = require('../../src/imaging/tci');
const { referenceFor, demoStore } = require('../../src/services/predictors/tciReference');
const { analyzePointwise } = require('../../src/services/predictors/pointwiseAnalysis');

const N = GRID.w * GRID.h;
const flat = (v) => new Float32Array(N).fill(v);
/** Grilla con valor `base` y `extra` sumado en las celdas del angiosoma `key`. */
function withAngiosome(base, key, extra) {
  const g = typeof base === 'number' ? flat(base) : Float32Array.from(base);
  for (let r = 0; r < GRID.h; r += 1) {
    for (let c = 0; c < GRID.w; c += 1) if (cellAngiosoma(r, c)?.key === key) g[r * GRID.w + c] += extra;
  }
  return g;
}
const member = (id, v) => ({ id, izq: flat(v), der: flat(v) });

describe('TCI (Hernández-Contreras et al. 2017) sobre la grilla canónica', () => {
  test('los cuatro angiosomas cubren la grilla sin solaparse', () => {
    const counts = Object.fromEntries(ANGIOSOMAS.map((a) => [a.key, 0]));
    for (let r = 0; r < GRID.h; r += 1) for (let c = 0; c < GRID.w; c += 1) counts[cellAngiosoma(r, c).key] += 1;
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(N);
    expect(Object.values(counts).every((n) => n > 0)).toBe(true);
  });

  test('pie uniformemente 1 °C más caliente que la referencia → TCI 1, clase 1, sin desvío de patrón', () => {
    const ref = buildReference([member('a', 30), member('b', 30), member('c', 30)]);
    const t = computeTci(flat(31), flat(31), ref);
    expect(t.valor).toBeCloseTo(1, 5);
    expect(t.izq).toBeCloseTo(1, 5);
    expect(t.clase).toBe(1);
    expect(t.puntual).toBeCloseTo(1, 5);
    expect(t.patron).toBeCloseTo(0, 5);
    expect(t.referencia.miembros).toBe(3);
  });

  test('usa el valor absoluto por angiosoma: +4 °C en un angiosoma de un pie → TCI de ese pie = 1', () => {
    const ref = buildReference([member('a', 28)]);
    const t = computeTci(withAngiosome(28, 'MCA', 4), flat(28), ref);
    expect(t.izq).toBeCloseTo(1, 5);
    expect(t.der).toBeCloseTo(0, 5);
    expect(t.valor).toBeCloseTo(0.5, 5);
    expect(t.angiosomas.izq.MCA).toBeCloseTo(4, 2);
    // Desvíos de signo opuesto no se cancelan.
    const g = withAngiosome(withAngiosome(28, 'MPA', 2), 'LPA', -2);
    expect(computeTci(g, g, ref).valor).toBeCloseTo(1, 5);
  });

  test('mapa de desvío punto a punto y celdas sin dato', () => {
    const ref = buildReference([member('a', 30), member('b', 32)]);
    const izq = flat(33);
    izq[0] = NaN;
    const t = computeTci(izq, flat(31), ref);
    expect(Number.isNaN(t.mapas.izq[0])).toBe(true);
    expect(t.mapas.izq[1]).toBeCloseTo(2, 5);
    expect(t.mapas.der[1]).toBeCloseTo(0, 5);
    expect(t.celdas).toBe(2 * N - 1);
  });

  test('una celda con pocos miembros con dato queda fuera de la referencia', () => {
    const a = member('a', 30);
    a.izq[5] = NaN;
    a.der[5] = NaN;
    const ref = buildReference([a, member('b', 30), member('c', 30)]);
    expect(Number.isFinite(ref.mean[5])).toBe(true);
    const sola = buildReference([a]);
    expect(Number.isNaN(sola.mean[5])).toBe(true);
  });

  test('leave-one-out: el paciente puntuado no integra su propia referencia', () => {
    const store = { fuente: 'cohorte', members: [member('P1', 30), member('P2', 30), member('P3', 36)] };
    const sinP3 = referenceFor(store, 'P3');
    expect(sinP3.miembros).toBe(2);
    expect(sinP3.excluido).toBe(true);
    expect(sinP3.mean[10]).toBeCloseTo(30, 5);
    const todos = referenceFor(store, 'OTRO');
    expect(todos.miembros).toBe(3);
    expect(todos.excluido).toBe(false);
    expect(computeTci(flat(36), flat(36), sinP3).valor).toBeCloseTo(6, 5);
    expect(computeTci(flat(36), flat(36), sinP3).clase).toBe(5);
  });

  test('clases de la publicación', () => {
    expect(claseTci(0)).toBe(1);
    expect(claseTci(2)).toBe(1);
    expect(claseTci(2.01)).toBe(2);
    expect(claseTci(4.5)).toBe(4);
    expect(claseTci(5.5)).toBe(5);
    expect(claseTci(NaN)).toBeNull();
  });

  test('sin referencia no hay TCI', () => {
    expect(computeTci(flat(30), flat(30), null)).toBeNull();
    expect(computeTci(flat(30), flat(30), buildReference([]))).toBeNull();
  });

  test('analyzePointwise agrega el TCI (con mapas serializados) o respeta el precalculado', () => {
    const ref = buildReference([member('a', 30)]);
    const grids = { toma1: { izq: encodeGrid(flat(31)), der: encodeGrid(flat(29)) } };
    const out = analyzePointwise(grids, { umbralPixel: 1 }, { tciReference: ref });
    const tci = out.tomas[0].tci;
    expect(tci.valor).toBeCloseTo(1, 5);
    expect(decodeGrid(tci.mapas.izq)[50]).toBeCloseTo(1, 2);
    expect(decodeGrid(tci.mapas.der)[50]).toBeCloseTo(-1, 2);
    expect(out.tomas[0].segmentacion).toBe('clasica');
    const pre = analyzePointwise(
      { toma1: { ...grids.toma1, tci: { valor: 9 }, segmentacion: 'unet' } },
      {},
      { tciReference: ref },
    );
    expect(pre.tomas[0].tci.valor).toBe(9);
    expect(pre.tomas[0].segmentacion).toBe('unet');
    expect(analyzePointwise(grids, {}).tomas[0].tci).toBeNull();
  });

  test('la referencia de demostración se arma con los pares demo', () => {
    const store = demoStore();
    expect(store.fuente).toBe('demo');
    expect(store.members.length).toBeGreaterThan(3);
    const ref = referenceFor(store);
    expect(ref.miembros).toBe(store.members.length);
  });
});
