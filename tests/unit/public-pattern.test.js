'use strict';

const { GRID, encodeGrid } = require('../../src/imaging/pointwise');
const { canonicalFromCrop, parseCsvMatrix, needsFlip } = require('../../src/imaging/footCrop');
const { patternFeatures, INVARIANT_KEYS } = require('../../src/imaging/thermalPattern');
const { cellAngiosoma, geometricAngiosoma, ANGIOSOMA_METODO } = require('../../src/imaging/tci');
const { predictPattern, loadPatternModel, patternModelInfo } = require('../../src/services/predictors/diabeticPattern');
const atlas = require('../../src/config/models/angiosome-atlas.json');

/** Pie sintético recortado (elipse), con la mitad medial a la izquierda si `medialIzq`. */
function syntheticCrop({ w = 60, h = 160, medialIzq = true, base = 28 } = {}) {
  const T = new Float32Array(w * h);
  const angio = {
    MPA: new Uint8Array(w * h),
    LPA: new Uint8Array(w * h),
    MCA: new Uint8Array(w * h),
    LCA: new Uint8Array(w * h),
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = (x - w / 2) / (w / 2 - 2);
      const dy = (y - h / 2) / (h / 2 - 2);
      if (dx * dx + dy * dy > 1) continue;
      const i = y * w + x;
      const medial = medialIzq ? x < w / 2 : x >= w / 2;
      T[i] = base + (medial ? 1 : 0) + y * 0.01;
      const talon = y > 0.65 * h;
      angio[talon ? (medial ? 'MCA' : 'LCA') : medial ? 'MPA' : 'LPA'][i] = 1;
    }
  }
  return { T, w, h, angio };
}

const gridsOf = (base = 28) => {
  const a = syntheticCrop({ base });
  const L = canonicalFromCrop(a.T, a.w, a.h, { angio: a.angio });
  const b = syntheticCrop({ base: base + 0.3, medialIzq: false });
  const R = canonicalFromCrop(b.T, b.w, b.h, { angio: b.angio });
  return { izq: L.grid, der: R.grid, L, R };
};

describe('Base pública: registro de pies recortados a la grilla canónica', () => {
  test('parsea el CSV de temperaturas (fondo 0) y rechaza filas irregulares', () => {
    const m = parseCsvMatrix('0,0,0\n0,31.5,30\r\n0,29,0\n');
    expect([m.w, m.h]).toEqual([3, 3]);
    expect(m.data[4]).toBeCloseTo(31.5, 3);
    expect(() => parseCsvMatrix('1,2\n3\n')).toThrow();
  });

  test('decide el espejado con los angiosomas para dejar el lado medial hacia +x', () => {
    const a = syntheticCrop({ medialIzq: true });
    const b = syntheticCrop({ medialIzq: false });
    expect(needsFlip(a.angio, a.w)).toBe(true);
    expect(needsFlip(b.angio, b.w)).toBe(false);
    const { L, R } = gridsOf();
    expect(L.flipped).toBe(true);
    expect(R.flipped).toBe(false);
    // Tras registrar, la mitad medial (columnas altas) es la más caliente en ambos pies.
    for (const g of [L.grid, R.grid]) {
      const r = 40;
      expect(g[r * GRID.w + GRID.w - 6]).toBeGreaterThan(g[r * GRID.w + 5]);
    }
    // Las etiquetas de angiosoma se muestrean en la misma grilla.
    expect(L.labels[40 * GRID.w + GRID.w - 6]).toBe(1); // MPA
    expect(L.labels[85 * GRID.w + 12]).toBe(4); // LCA
  });
});

describe('Atlas de angiosomas (base pública 2019)', () => {
  test('el TCI usa el atlas y cubre toda la grilla', () => {
    expect(ANGIOSOMA_METODO).toMatch(/atlas/);
    const keys = ['', 'MPA', 'LPA', 'MCA', 'LCA'];
    let iguales = 0;
    let conEtiqueta = 0;
    for (let r = 0; r < GRID.h; r += 1) {
      for (let c = 0; c < GRID.w; c += 1) {
        expect(cellAngiosoma(r, c)).not.toBeNull();
        const k = Number(atlas.filas[r][c]);
        if (!k) continue;
        conEtiqueta += 1;
        if (cellAngiosoma(r, c).key === keys[k]) iguales += 1;
      }
    }
    expect(iguales).toBe(conEtiqueta);
    expect(geometricAngiosoma(10, 30).key).toBe('MPA');
  });
});

describe('Features invariantes a la adquisición', () => {
  test('un corrimiento constante de la escala no cambia ninguna feature invariante', () => {
    const a = gridsOf(28);
    const shift = (g) => Float32Array.from(g, (v) => (Number.isFinite(v) ? v + 4.5 : NaN));
    const f1 = patternFeatures(a.izq, a.der);
    const f2 = patternFeatures(shift(a.izq), shift(a.der));
    for (const k of INVARIANT_KEYS) {
      if (f1[k] === null) expect(f2[k]).toBeNull();
      else expect(f2[k]).toBeCloseTo(f1[k], 2);
    }
    expect(f2.nivel - f1.nivel).toBeCloseTo(4.5, 2);
    expect(f1.relMPA).toBeGreaterThan(0); // la mitad medial es más caliente que la mediana
    expect(f1.difNivel).toBeCloseTo(0.3, 1);
  });

  test('sin datos suficientes devuelve null', () => {
    const vacia = new Float32Array(GRID.w * GRID.h).fill(NaN);
    expect(patternFeatures(vacia, vacia)).toBeNull();
  });
});

describe('Modelo de patrón térmico compatible con pie diabético', () => {
  const model = loadPatternModel();

  test('el modelo exportado declara qué predice y qué no, con su validación', () => {
    expect(model).not.toBeNull();
    expect(model.noPredice).toMatch(/no predice úlcera/i);
    const info = patternModelInfo(model);
    expect(info.n).toBeGreaterThan(100);
    expect(info.auc).toBeGreaterThan(0.5);
    expect(info.aucIC95).toHaveLength(2);
  });

  test('predice una probabilidad 0–100 invariante a un corrimiento de la escala', () => {
    const a = gridsOf(28);
    const shift = (g) => Float32Array.from(g, (v) => (Number.isFinite(v) ? v - 3 : NaN));
    const t = { toma: 1, izq: encodeGrid(a.izq), der: encodeGrid(a.der) };
    const t2 = { toma: 1, izq: encodeGrid(shift(a.izq)), der: encodeGrid(shift(a.der)) };
    const p1 = predictPattern(model, t);
    const p2 = predictPattern(model, t2);
    expect(p1.probabilidad).toBeGreaterThanOrEqual(0);
    expect(p1.probabilidad).toBeLessThanOrEqual(100);
    expect(p2.probabilidad).toBeCloseTo(p1.probabilidad, 0);
    expect(p1.factores.length).toBeLessThanOrEqual(4);
    expect(p1.n).toBe(model.validacion.n);
  });

  test('sin modelo o sin grillas no hay resultado', () => {
    expect(predictPattern(null, { izq: 'x', der: 'y' })).toBeNull();
    expect(predictPattern(model, {})).toBeNull();
  });
});
