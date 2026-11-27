'use strict';

const {
  meanGrid,
  pasaCriterios,
  replicasParaPromedio,
  estabilidad,
  promediarToma,
  sd,
} = require('../../src/imaging/replicaAverage');
const { promedioFotos } = require('../../src/utils/pointwiseView');

const g = (arr) => Float32Array.from(arr);
const cand = (rep, banderas, izq = [0], der = izq) => ({ rep, banderas, cf: { izq: g(izq), der: g(der) } });

describe('meanGrid', () => {
  it('promedia celda a celda', () => {
    expect(Array.from(meanGrid([g([30, 32]), g([32, 34])]))).toEqual([31, 33]);
  });

  it('promedia cada celda sólo entre las réplicas que la midieron (sin rellenar)', () => {
    const out = meanGrid([g([30, NaN, NaN]), g([32, 34, NaN]), g([NaN, 36, NaN])]);
    expect(out[0]).toBeCloseTo(31);
    expect(out[1]).toBeCloseTo(35);
    expect(Number.isNaN(out[2])).toBe(true);
  });

  it('rechaza grillas de distinto tamaño o lista vacía', () => {
    expect(() => meanGrid([])).toThrow();
    expect(() => meanGrid([g([1]), g([1, 2])])).toThrow();
  });
});

describe('selección de réplicas para el promedio', () => {
  it('pasan sólo las réplicas sin banderas graves (las leves no excluyen)', () => {
    expect(pasaCriterios({ banderas: [] })).toBe(true);
    expect(pasaCriterios({ banderas: ['pies_girados', 'fondo_tibio', 'foto_borrosa'] })).toBe(true);
    for (const b of [
      'talon_cortado',
      'dedos_cortados',
      'pie_cortado',
      'camara_lejos',
      'pie_incompleto',
      'fuga_talon',
      'tamanos_distintos',
      'pies_juntos',
      'poco_contraste',
      'desenfocada',
    ])
      expect(pasaCriterios({ banderas: [b] })).toBe(false);
    expect(pasaCriterios({})).toBe(false);
  });

  it('usa todas las que pasan, en orden de captura', () => {
    const c = [cand(2, []), cand(0, ['pies_juntos']), cand(1, ['pies_girados'])];
    const r = replicasParaPromedio(c, c[1]);
    expect(r.promedio).toBe(true);
    expect(r.usadas.map((x) => x.rep)).toEqual([1, 2]);
  });

  it('si ninguna pasa, usa la mejor sola', () => {
    const c = [cand(0, ['pies_juntos']), cand(1, ['camara_lejos'])];
    const r = replicasParaPromedio(c, c[1]);
    expect(r.promedio).toBe(false);
    expect(r.usadas).toEqual([c[1]]);
  });
});

describe('promediarToma', () => {
  it('promedia las réplicas que pasan e informa cuáles se usaron', () => {
    const c = [cand(0, [], [30, 31], [29, 31]), cand(1, ['pie_incompleto'], [40, 40]), cand(2, [], [32, NaN], [31, 33])];
    const pr = promediarToma(c, c[0]);
    expect(Array.from(pr.izq)).toEqual([31, 31]);
    expect(Array.from(pr.der)).toEqual([30, 32]);
    expect(pr.info).toEqual({ n: 2, promedio: true, reps: [1, 3], estabilidad: null });
  });

  it('con una sola réplica usa sus grillas tal cual', () => {
    const c = [cand(0, ['pies_juntos'], [30, 31])];
    const pr = promediarToma(c, c[0]);
    expect(pr.izq).toBe(c[0].cf.izq);
    expect(pr.info).toMatchObject({ n: 1, promedio: false, reps: [1] });
  });

  it('calcula la estabilidad entre réplicas con las métricas de cada una', () => {
    const c = [cand(0, [], [1]), cand(1, [], [2]), cand(2, [], [3])];
    const areas = { 1: 30, 2: 40, 3: 50 };
    const pr = promediarToma(c, c[0], { metricas: (izq) => ({ areaCalientePct: areas[izq[0]], maxAbs: izq[0] }) });
    expect(pr.info.estabilidad).toEqual({ areaCalienteDe: 10, areaCalienteMin: 30, areaCalienteMax: 50, deltaMaxDe: 1 });
  });

  it('sd y estabilidad necesitan al menos dos valores', () => {
    expect(sd([1])).toBeNull();
    expect(estabilidad([{ areaCalientePct: 10, maxAbs: 1 }])).toBeNull();
  });
});

describe('promedioFotos (texto del estudio)', () => {
  const t = (promedio) => ({ calidadFotos: { promedio } });
  it('«Promedio de 3 fotos» con las réplicas y la variación', () => {
    const pf = promedioFotos(
      t({ n: 3, promedio: true, reps: [1, 2, 4], estabilidad: { areaCalienteDe: 8.5, areaCalienteMin: 34, areaCalienteMax: 51 } }),
    );
    expect(pf.corto).toBe('Promedio de 3 fotos');
    expect(pf.detalle).toContain('réplicas 1, 2 y 4');
    expect(pf.detalle).toContain('34–51 %');
  });
  it('una sola foto o ninguna que pase', () => {
    expect(promedioFotos(t({ n: 1, promedio: true, reps: [2], estabilidad: null })).corto).toBe('1 foto');
    expect(promedioFotos(t({ n: 1, promedio: false, reps: [3], estabilidad: null })).corto).toMatch(/ninguna pasa/);
    expect(promedioFotos({})).toBeNull();
  });
});
