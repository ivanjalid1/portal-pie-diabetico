'use strict';

const { decodeIs2 } = require('../../src/imaging/is2');
const { fakeIs2 } = require('../helpers/is2');
const { segmentFeetPointwise } = require('../../src/imaging/segmentation');
const P = require('../../src/imaging/pointwise');
const { analyzePointwise, zonasTexto } = require('../../src/services/predictors/pointwiseAnalysis');
const L = require('../../src/services/predictors/logistic');
const { marcaSinConsentimiento } = require('../../src/utils/consent');

/** Termograma sintético en °C: dos «pies» elípticos; opciones para recortar o calentar. */
function syntheticImage({ cutTopRight = 0, hotRightToes = 0 } = {}) {
  const width = 320;
  const height = 240;
  const data = new Uint16Array(width * height);
  const counts = (c) => Math.round((c - P.celsiusImage({ data: [0] })[0]) / 0.012978);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let t = 22 + ((x * 7 + y * 13) % 5) * 0.02;
      const inFoot = (cx) => ((x - cx) / 30) ** 2 + ((y - 120) / 95) ** 2 <= 1;
      if (inFoot(100)) t = 30 + ((x + y) % 3) * 0.02;
      if (inFoot(220) && y >= cutTopRight) {
        t = 30 + ((x * 3 + y) % 3) * 0.02;
        if (hotRightToes && y < 55) t += hotRightToes;
      }
      data[y * width + x] = counts(t);
    }
  }
  return { width, height, data };
}

describe('Segmentación y registro punto a punto', () => {
  it('segmenta dos pies del IS2 sintético (izquierdo de la imagen = pie izquierdo)', () => {
    const img = decodeIs2(fakeIs2());
    const seg = segmentFeetPointwise(P.celsiusImage(img), img);
    expect(seg.ok).toBe(true);
    const cx = (m) => {
      let s = 0;
      let n = 0;
      m.forEach((v, i) => {
        if (v) {
          s += i % img.width;
          n += 1;
        }
      });
      return s / n;
    };
    expect(cx(seg.feet[0].mask)).toBeLessThan(cx(seg.feet[1].mask));
    expect(seg.feet[0].area).toBeGreaterThan(5000);
  });

  it('registra ambos pies en la grilla canónica: pies simétricos → casi sin área caliente', () => {
    const cf = P.canonicalFeet(syntheticImage());
    expect(cf.ok).toBe(true);
    expect(cf.izq).toHaveLength(P.GRID.w * P.GRID.h);
    const m = P.asymmetryMetrics(cf.izq, cf.der, { umbralPixel: 1 });
    expect(m.areaCalientePct).toBeLessThan(1);
    expect(m.mediaAbs).toBeLessThan(0.2);
    expect(P.qualityScore(cf)).toBeGreaterThan(0.8);
  });

  it('ubica el punto caliente en los dedos del pie derecho (ΔT = izq − der negativo)', () => {
    const cf = P.canonicalFeet(syntheticImage({ hotRightToes: 2.5 }));
    const m = P.asymmetryMetrics(cf.izq, cf.der, { umbralPixel: 1 });
    expect(m.areaCalientePct).toBeGreaterThan(5);
    expect(m.hotspot.zona).toBe('dedos');
    expect(m.hotspot.pieMasCaliente).toBe('derecho');
    expect(m.hotspot.deltaT).toBeLessThan(-1.5);
    expect(m.maxAbs).toBeGreaterThan(2);
  });

  it('detecta los dedos fuera del cuadro y los excluye de las métricas sin inventar datos', () => {
    const cf = P.canonicalFeet(syntheticImage({ cutTopRight: 60 }));
    expect(cf.ok).toBe(true);
    expect(cf.marco.der.recortes).toContain('dedos');
    const enc = { izq: P.encodeGrid(cf.izq), der: P.encodeGrid(cf.der) };
    const pw = analyzePointwise({ toma1: enc }, { umbralPixel: 1 });
    const t = pw.tomas[0];
    expect(t.zonasNoAnalizadas).toContain('dedos');
    expect(t.zonasAnalizadas).toEqual(expect.arrayContaining(['metatarso', 'arco', 'talon']));
    expect(zonasTexto(t)).toEqual({ noAnalizado: 'dedos', analizado: 'metatarso, arco y talón' });
    // Las celdas faltantes quedan sin dato (NaN), nunca se completan.
    const der = P.decodeGrid(enc.der);
    expect(der.slice(0, P.GRID.w * 5).every((v) => Number.isNaN(v))).toBe(true);
    expect(pw.tieneToma2).toBe(false);
    expect(pw.cambio).toBeNull();
  });

  it('serializa las grillas sin pérdida relevante (centésimas de °C, NaN preservado)', () => {
    const g = Float32Array.from([30.123, NaN, -1.5, 0]);
    const back = P.decodeGrid(P.encodeGrid(g));
    expect(back[0]).toBeCloseTo(30.12, 2);
    expect(Number.isNaN(back[1])).toBe(true);
    expect(back[2]).toBe(-1.5);
  });

  it('calcula el cambio entre tomas por pie (T2 − T1) y su mediana', () => {
    const a = P.canonicalFeet(syntheticImage());
    const b = P.canonicalFeet(syntheticImage({ hotRightToes: 2 }));
    const pw = analyzePointwise(
      {
        toma1: { izq: P.encodeGrid(a.izq), der: P.encodeGrid(a.der) },
        toma2: { izq: P.encodeGrid(b.izq), der: P.encodeGrid(b.der) },
      },
      { umbralPixel: 1, umbralCambio: 1 },
    );
    expect(pw.tieneToma2).toBe(true);
    expect(Math.abs(pw.cambio.izq.mediana)).toBeLessThan(0.1);
    expect(pw.cambio.der.areaCambioLocalPct).toBeGreaterThan(5);
    expect(pw.rois.toma1.map((r) => r.roi)).toContain('general');
  });
});

describe('Regresión logística y validación', () => {
  it('ajusta, predice y calcula el AUC', () => {
    const X = [];
    const y = [];
    for (let i = 0; i < 40; i += 1) {
      X.push([i % 2 ? 2 + (i % 5) * 0.1 : -2 + (i % 7) * 0.1]);
      y.push(i % 2);
    }
    const s = L.standardize(X);
    const m = L.fitLogistic(
      X.map((x) => L.applyScale(x, s)),
      y,
    );
    expect(m.coef[0]).toBeGreaterThan(0);
    expect(L.auc(L.looPredictions(X, y), y)).toBeGreaterThan(0.95);
    expect(L.auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1])).toBeCloseTo(0.75, 5);
    const kf = L.repeatedKFoldAuc(X, y, { k: 5, reps: 2 });
    expect(kf).toHaveLength(2);
  });
});

describe('Marca «sin consentimiento» de la planilla', () => {
  it('la detecta con variantes y errores de tipeo, sin falsos positivos', () => {
    for (const t of [
      'SIN CONCENTIMIENTO',
      'sin consentimiento del paciente',
      'No firmó el consentimiento',
      'rechazó consentimiento',
    ]) {
      expect(marcaSinConsentimiento(t)).toBe(true);
    }
    for (const t of [
      'Consentimiento firmado',
      'PACIENTE NO VALIDO X IMAGEN',
      'Consentimiento informado vigente',
      null,
    ]) {
      expect(marcaSinConsentimiento(t)).toBe(false);
    }
  });
});

describe('Lectura en lenguaje simple del resultado', () => {
  const pwv = require('../../src/utils/pointwiseView');
  const N = P.GRID.w * P.GRID.h;
  const grids = (hot) => {
    const izq = new Float32Array(N).fill(30);
    const der = new Float32Array(N).fill(30);
    // Metatarso (filas 20–41): el pie izquierdo 2 °C más caliente en `hot` filas.
    for (let r = 22; r < 22 + hot; r += 1) for (let c = 0; c < P.GRID.w; c += 1) izq[r * P.GRID.w + c] = 32;
    return { izq: P.encodeGrid(izq), der: P.encodeGrid(der) };
  };

  it('nombra el pie más caliente y la zona donde se concentra la diferencia', () => {
    const pwA = analyzePointwise({ toma1: grids(4), toma2: grids(15) }, { umbralPixel: 1, areaMinima: 10 });
    const t2 = pwA.tomas[1];
    const l = pwv.lecturaToma(t2, 1);
    expect(l.pie).toBe('izquierdo');
    expect(l.zona).toBe('metatarso');
    expect(l.frase).toBe(
      'El 15 % de la planta del pie izquierdo está más de 1,0 °C más caliente que el derecho, sobre todo en el metatarso.',
    );
    const AnalysisResult = require('../../src/models/AnalysisResult');
    const a = new AnalysisResult({ studyId: 's', probabilidad: 10, categoria: 'bajo', puntual: pwA });
    expect(pwv.cambioArea(a)).toMatchObject({ delta: 11, sentido: 'aumentó' });
  });

  it('describe pies parecidos y las zonas no analizadas con artículo', () => {
    const pwA = analyzePointwise({ toma1: grids(0) }, { umbralPixel: 1 });
    expect(pwv.lecturaToma(pwA.tomas[0], 1).frase).toMatch(/^Los dos pies tienen temperaturas parecidas/);
    expect(pwv.noAnalizadoTexto({ zonasNoAnalizadas: ['dedos'] })).toBe('no se analizaron los dedos');
    expect(pwv.noAnalizadoTexto({ zonasNoAnalizadas: ['talon'] })).toBe('no se analizó el talón');
    expect(pwv.noAnalizadoTexto({ zonasNoAnalizadas: [] })).toBeNull();
  });
});
