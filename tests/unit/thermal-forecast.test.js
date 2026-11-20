'use strict';

const ThermalForecastService = require('../../src/services/ThermalForecastService');
const { zoneFeatures, loadForecastModel, isUsable } = ThermalForecastService;
const { GRID, encodeGrid, zonaDeFila } = require('../../src/imaging/pointwise');
const { buildCsv } = require('../../src/utils/csv');
const { pronosticoFrase } = require('../../src/utils/pointwiseView');

/** Coeficientes sintéticos (no derivan de datos reales). */
const MODEL = Object.freeze({
  version: 'pronostico-zonas-test',
  umbralPixel: 1,
  areaUmbral: 10,
  horizonteDias: { mediana: 35, p25: 31, p75: 42, n: 10 },
  n: { pares: 10, filasPieZona: 80, pacientes: 10 },
  area: { intercepto: 5, pendiente: 0.4, rango80: [-8, 14], cv: { mae: 9, maePersistencia: 10 } },
  dT: { intercepto: 0, pendiente: 0.5, rango80: [-0.5, 0.5], cv: { mae: 0.37, maePersistencia: 0.42 } },
  planta: { intercepto: 10, pendiente: 0.3, rango80: [-12, 18], cv: { mae: 10, maePersistencia: 12 } },
  prob: {
    intercepto: -2,
    coefArea: 0.5,
    coefDT: 0.8,
    calibracion: { intercepto: 0, pendiente: 1 },
    cv: { auc: 0.75, aucIC95: [0.69, 0.8], aucPersistencia: 0.74, pendienteCalibracion: 0.99 },
  },
  pixel: { beta: 0.4, cv: { mae: 0.54, maePersistencia: 0.64, maeCero: 0.58 } },
});

/**
 * Grillas sintéticas: ambos pies a 30 °C; en las zonas indicadas el pie
 * derecho está `delta` °C más frío (el izquierdo queda más caliente).
 */
function grids(calientesIzq = {}, sinDato = []) {
  const izq = new Float32Array(GRID.w * GRID.h).fill(30);
  const der = new Float32Array(GRID.w * GRID.h).fill(30);
  for (let r = 0; r < GRID.h; r += 1) {
    const z = zonaDeFila(r).key;
    for (let c = 0; c < GRID.w; c += 1) {
      const i = r * GRID.w + c;
      if (sinDato.includes(z)) {
        izq[i] = NaN;
        der[i] = NaN;
      } else if (calientesIzq[z] !== undefined) {
        // Sólo la mitad lateral de la zona (columnas < 20) para tener 50 % de área.
        const frac = calientesIzq[z].frac ?? 1;
        if (c < GRID.w * frac) der[i] = 30 - calientesIzq[z].delta;
      }
    }
  }
  return { izq, der };
}

function toma(k, g, extra = {}) {
  return {
    toma: k,
    izq: encodeGrid(g.izq),
    der: encodeGrid(g.der),
    zonasNoAnalizadas: extra.zonasNoAnalizadas || [],
    metricas: { areaCalientePct: extra.areaCalientePct ?? 0 },
  };
}

const analysis = (...tomas) => ({ parametros: { areaMinima: 10 }, puntual: { umbralPixel: 1, areaMinima: 10, tomas } });
const zona = (fc, pie, z) => fc.pies.find((p) => p.pie === pie).zonas.find((x) => x.zona === z);

describe('zoneFeatures', () => {
  test('% de área caliente y ΔT orientado por pie y zona', () => {
    const g = grids({ metatarso: { delta: 2, frac: 0.5 } });
    const f = zoneFeatures(g.izq, g.der, { umbral: 1 });
    expect(f.izq.metatarso.areaPct).toBeCloseTo(50, 5);
    expect(f.izq.metatarso.dT).toBeCloseTo(1, 5);
    expect(f.der.metatarso.areaPct).toBe(0);
    expect(f.der.metatarso.dT).toBeCloseTo(-1, 5);
    expect(f.izq.dedos.areaPct).toBe(0);
    expect(f.izq.talon.dT).toBe(0);
  });

  test('las zonas excluidas o sin celdas quedan en null', () => {
    const g = grids({}, ['dedos']);
    const f = zoneFeatures(g.izq, g.der, { excluidas: ['talon'] });
    expect(f.izq.dedos).toBeNull();
    expect(f.der.talon).toBeNull();
    expect(f.izq.arco).not.toBeNull();
  });

  test('un punto por encima del umbral en el otro pie cuenta para ese pie', () => {
    const g = grids();
    g.izq[0] = 25; // dedos: el derecho 5 °C más caliente en un punto
    const f = zoneFeatures(g.izq, g.der, { umbral: 1 });
    expect(f.der.dedos.areaPct).toBeGreaterThan(0);
    expect(f.izq.dedos.areaPct).toBe(0);
  });
});

describe('ThermalForecastService con modelo', () => {
  const svc = new ThermalForecastService({ model: MODEL });

  test('esperado = a + b · actual, rango 80 % acotado a 0–100 y ΔT esperado', () => {
    const g = grids({ metatarso: { delta: 2 } });
    const fc = svc.forAnalysis(analysis(toma(1, g, { areaCalientePct: 22 })));
    const m = zona(fc, 'izq', 'metatarso');
    expect(m.actual.areaPct).toBe(100);
    expect(m.esperado.areaPct).toBe(45);
    expect(m.esperado.rango).toEqual([37, 59]);
    expect(m.esperado.dT).toBe(1);
    const fria = zona(fc, 'der', 'metatarso');
    expect(fria.esperado.areaPct).toBe(5);
    expect(fria.esperado.rango).toEqual([0, 19]);
    expect(fc.disponible).toBe(true);
    expect(fc.horizonteDias.mediana).toBe(35);
    expect(fc.areaUmbral).toBe(10);
  });

  test('probabilidad logística recalibrada', () => {
    const g = grids({ metatarso: { delta: 2 } });
    const fc = svc.forAnalysis(analysis(toma(1, g)));
    const lin = -2 + 0.5 * (100 / 10) + 0.8 * 2;
    expect(zona(fc, 'izq', 'metatarso').prob).toBeCloseTo(1 / (1 + Math.exp(-lin)), 3);
    const recal = new ThermalForecastService({
      model: { ...MODEL, prob: { ...MODEL.prob, calibracion: { intercepto: -1, pendiente: 0.5 } } },
    });
    const p2 = zona(recal.forAnalysis(analysis(toma(1, g))), 'izq', 'metatarso').prob;
    expect(p2).toBeCloseTo(1 / (1 + Math.exp(-(-1 + 0.5 * lin))), 3);
  });

  test('no se rotula una tendencia (sería sobre todo regresión a la media)', () => {
    const fc = svc.forAnalysis(analysis(toma(1, grids({ metatarso: { delta: 2 } }))));
    expect(zona(fc, 'izq', 'metatarso')).not.toHaveProperty('tendencia');
    expect(fc.peor).not.toHaveProperty('tendencia');
  });

  test('alerta IWGDF: p95 de la zona ≥ 2,2 °C en ambas tomas, el mismo pie', () => {
    const fuerte = { delta: 2.5 };
    const t1 = toma(1, grids({ metatarso: fuerte, talon: fuerte, arco: { delta: 2 } }));
    const t2 = toma(2, grids({ metatarso: fuerte, arco: { delta: 2 } }));
    const fc = svc.forAnalysis(analysis(t1, t2));
    expect(zona(fc, 'izq', 'metatarso').alertaIwgdf).toBe(true);
    expect(zona(fc, 'izq', 'talon').alertaIwgdf).toBe(false); // sólo en la toma 1
    expect(zona(fc, 'izq', 'arco').alertaIwgdf).toBe(false); // persistente pero < 2,2 °C
    expect(zona(fc, 'izq', 'arco').persistente).toBe(true);
    expect(fc.alertas).toEqual([{ pie: 'izq', zona: 'metatarso', texto: 'metatarso izq.', p95: [2.5, 2.5] }]);
    expect(fc.umbralIwgdf).toBe(2.2);
    // Con una sola toma no hay alerta, y no depende del modelo.
    expect(svc.forAnalysis(analysis(t1)).alertas).toEqual([]);
    expect(new ThermalForecastService({ model: null }).forAnalysis(analysis(t1, t2)).alertas).toHaveLength(1);
  });

  test('el p95 de la zona es robusto a un punto aislado', () => {
    const g = grids();
    g.der[25 * GRID.w + 5] = 20; // un punto 10 °C más frío en el metatarso derecho
    const f = zoneFeatures(g.izq, g.der);
    expect(f.izq.metatarso.p95).toBe(0);
  });

  test('zona caliente persistente: sobre el área mínima en ambas tomas', () => {
    const t1 = toma(1, grids({ metatarso: { delta: 2 }, talon: { delta: 2 } }));
    const t2 = toma(2, grids({ metatarso: { delta: 2, frac: 0.5 } }));
    const fc = svc.forAnalysis(analysis(t1, t2));
    expect(fc.desdeToma).toBe(2);
    expect(fc.tomas).toBe(2);
    expect(zona(fc, 'izq', 'metatarso').persistente).toBe(true);
    expect(zona(fc, 'izq', 'metatarso').previo.areaPct).toBe(100);
    expect(zona(fc, 'izq', 'talon').persistente).toBe(false); // resolvió en la toma 2
    expect(fc.persistentes).toEqual([{ pie: 'izq', zona: 'metatarso', texto: 'metatarso izq.', areaPct: [100, 50] }]);
  });

  test('con una sola toma no hay persistencia', () => {
    const fc = svc.forAnalysis(analysis(toma(1, grids({ metatarso: { delta: 2 } }))));
    expect(fc.persistentes).toEqual([]);
  });

  test('la persistencia respeta el área mínima indicada', () => {
    const t1 = toma(1, grids({ arco: { delta: 2, frac: 0.15 } }));
    const t2 = toma(2, grids({ arco: { delta: 2, frac: 0.15 } }));
    expect(svc.forAnalysis(analysis(t1, t2)).persistentes).toHaveLength(1);
    expect(svc.forAnalysis(analysis(t1, t2), { areaMinima: 20 }).persistentes).toHaveLength(0);
  });

  test('zona no analizada: sin valores ni pronóstico', () => {
    const fc = svc.forAnalysis(analysis(toma(1, grids({}, ['dedos']), { zonasNoAnalizadas: ['dedos'] })));
    const d = zona(fc, 'izq', 'dedos');
    expect(d.actual).toBeNull();
    expect(d.esperado).toBeNull();
  });

  test('peor zona, planta completa y β del mapa', () => {
    const g = grids({ metatarso: { delta: 2 } });
    const fc = svc.forAnalysis(analysis(toma(1, g, { areaCalientePct: 22 })));
    expect(fc.peor).toMatchObject({ pie: 'izq', zona: 'metatarso', texto: 'metatarso izq.', esperado: 45 });
    expect(fc.planta).toEqual({ actual: 22, esperado: 16.6, rango: [4.6, 34.6] });
    expect(fc.beta).toBe(0.4);
  });

  test('sin análisis punto a punto no hay pronóstico', () => {
    expect(svc.forAnalysis(null)).toBeNull();
    expect(svc.forAnalysis({ puntual: null })).toBeNull();
    expect(svc.forAnalysis({ puntual: { tomas: [] } })).toBeNull();
  });

  test('info expone las métricas para el detalle técnico', () => {
    expect(svc.info).toMatchObject({ version: 'pronostico-zonas-test', area: { mae: 9 }, prob: { auc: 0.75 } });
  });
});

describe('ThermalForecastService sin modelo (CI, Vercel)', () => {
  const svc = new ThermalForecastService({ model: null });

  test('no pronostica, pero marca la persistencia', () => {
    const t1 = toma(1, grids({ metatarso: { delta: 2 } }));
    const t2 = toma(2, grids({ metatarso: { delta: 2 } }));
    const fc = svc.forAnalysis(analysis(t1, t2));
    expect(svc.disponible).toBe(false);
    expect(svc.info).toBeNull();
    expect(fc.disponible).toBe(false);
    expect(fc.peor).toBeNull();
    expect(fc.beta).toBeNull();
    expect(zona(fc, 'izq', 'metatarso').esperado).toBeNull();
    expect(fc.persistentes).toHaveLength(1);
  });

  test('un modelo incompleto se descarta', () => {
    expect(isUsable({ area: { intercepto: 1 } })).toBe(false);
    expect(isUsable(MODEL)).toBe(true);
    expect(new ThermalForecastService({ model: { area: {} } }).disponible).toBe(false);
  });

  test('en las pruebas no se lee el modelo local', () => {
    expect(loadForecastModel()).toBeNull();
    expect(new ThermalForecastService().disponible).toBe(false);
  });
});

describe('Salidas del pronóstico', () => {
  const svc = new ThermalForecastService({ model: MODEL });
  const t1 = toma(1, grids({ metatarso: { delta: 2 } }));
  const t2 = toma(2, grids({ metatarso: { delta: 2 } }), { areaCalientePct: 22 });

  test('CSV: zona peor, área esperada, persistencia y alerta IWGDF', () => {
    const forecast = svc.forAnalysis(analysis(t1, t2));
    const csv = buildCsv([
      { patient: { codigo: 'P.X001', edad: () => null, gradoNeuropatia: '' }, study: null, analysis: null, forecast },
    ]);
    const [head, row] = csv.slice(1).trim().split('\r\n');
    const col = (name) => row.split(';')[head.split(';').indexOf(name)];
    expect(col('PRONOSTICO ZONA')).toBe('METATARSO IZQ.');
    expect(col('PRONOSTICO AREA ESPERADA (%)')).toBe('45,0');
    expect(col('PRONOSTICO RANGO 80 (%)')).toBe('37,0-59,0');
    expect(head.split(';')).not.toContain('PRONOSTICO TENDENCIA');
    expect(col('ALERTA IWGDF 2,2 °C PERSISTENTE')).toBe('NO');
    expect(col('ZONA CALIENTE PERSISTENTE')).toBe('SI');
    expect(col('ZONAS PERSISTENTES')).toBe('METATARSO IZQ.');
  });

  test('frase para el paciente en lenguaje simple', () => {
    expect(pronosticoFrase(svc.forAnalysis(analysis(t1, t2)))).toBe(
      'En tu próximo control vamos a volver a comparar la temperatura de tus pies, sobre todo en el metatarso del pie izquierdo.',
    );
    expect(pronosticoFrase(svc.forAnalysis(analysis(toma(1, grids()))))).toBe(
      'En tu próximo control vamos a volver a comparar la temperatura de tus dos pies.',
    );
    expect(pronosticoFrase(new ThermalForecastService({ model: null }).forAnalysis(analysis(t1, t2)))).toBeNull();
  });
});
