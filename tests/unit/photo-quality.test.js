'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Q = require('../../src/imaging/photoQuality');
const { cleanFeetMasks } = require('../../src/imaging/maskCleanup');
const { alignVisible, reconcileShifts, visibleSharpness } = require('../../src/imaging/visibleAlign');
const { ThermalViewerService } = require('../../src/services/ThermalViewerService');
const { calidadFotosAviso } = require('../../src/utils/pointwiseView');

const W = 320;
const H = 240;

/** Pie sintético: elipse (largo 2·a, ancho 2·b) centrada en (cx, cy). */
function ellipse(cx, cy, a, b) {
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (((x - cx) / b) ** 2 + ((y - cy) / a) ** 2 <= 1) m[y * W + x] = 1;
    }
  }
  return m;
}

/** Temperatura: fondo y pies (°C). */
function scene(masks, { fondo = 22, pie = 30 } = {}) {
  const T = new Float32Array(W * H).fill(fondo);
  for (const m of masks) for (let i = 0; i < T.length; i += 1) if (m[i]) T[i] = pie;
  return T;
}

const pair = ({ dy = 0, scale = 1, gap = 60 } = {}) => {
  const a = 75 * scale;
  const b = 29 * scale;
  return [ellipse(160 - gap / 2 - b, 120 + dy, a, b), ellipse(160 + gap / 2 + b, 120 + dy, a, b)];
};

function metrics(masks, opts) {
  return Q.replicaMetrics({ T: scene(masks, opts), masks, width: W, height: H });
}

describe('Calidad automática por réplica: medidas y banderas', () => {
  test('un par de pies bien encuadrado no tiene banderas graves', () => {
    const m = metrics(pair());
    expect(m.largoMin).toBeGreaterThan(140);
    expect(m.largoAnchoMin).toBeGreaterThan(2.2);
    expect(m.largoAnchoMax).toBeLessThan(3.0);
    expect(m.areaRatio).toBeCloseTo(1, 2);
    expect(m.contraste).toBeCloseTo(8, 5);
    expect(m.separacion).toBeGreaterThan(50);
    expect(m.puente).toBe(false);
    const flags = Q.qualityFlags(m);
    expect(flags.filter(Q.esGrave)).toEqual([]);
  });

  test('talón cortado por el borde inferior', () => {
    const flags = Q.qualityFlags(metrics(pair({ dy: 50 })));
    expect(flags).toContain('talon_cortado');
  });

  test('pies chicos: cámara lejos', () => {
    expect(Q.qualityFlags(metrics(pair({ scale: 0.75 })))).toContain('camara_lejos');
  });

  test('pies juntos (tocándose o a ≤ 3 px)', () => {
    expect(Q.qualityFlags(metrics(pair({ gap: 2 })))).toContain('pies_juntos');
    expect(Q.qualityFlags(metrics(pair({ gap: 0 })))).toContain('pies_juntos');
  });

  test('poco contraste pie–fondo', () => {
    expect(Q.qualityFlags(metrics(pair(), { fondo: 24, pie: 27 }))).toContain('poco_contraste');
  });

  test('IR desenfocada: el borde térmico es difuso', () => {
    const masks = pair();
    const T = Q.gaussian(scene(masks), W, H, 4);
    const m = Q.replicaMetrics({ T, masks, width: W, height: H });
    expect(Q.qualityFlags(m)).toContain('desenfocada');
    expect(Q.qualityFlags(metrics(masks))).not.toContain('desenfocada');
  });

  test('foto visible borrosa y foto desalineada sin corregir son avisos leves', () => {
    const m = { ...metrics(pair()), nitidezFoto: 3, alineacion: { dx: 8, dy: 0, aplicada: false } };
    const flags = Q.qualityFlags(m);
    expect(flags).toEqual(expect.arrayContaining(['foto_borrosa', 'foto_desalineada']));
    expect(flags.some(Q.esGrave)).toBe(false);
    // Si la alineación se aplicó, no se avisa.
    expect(Q.qualityFlags({ ...m, alineacion: { dx: 8, dy: 0, aplicada: true } })).not.toContain('foto_desalineada');
  });

  test('las etiquetas son en lenguaje simple y se ignoran códigos desconocidos', () => {
    expect(Q.flagLabels(['talon_cortado', 'xx', 'poco_contraste'])).toEqual([
      { code: 'talon_cortado', label: 'Talón cortado', grave: true },
      { code: 'poco_contraste', label: 'Poco contraste', grave: true },
    ]);
  });

  test('encuadre y giro sugerido sólo para la vista', () => {
    const { encuadre, giro } = Q.displayHints(metrics(pair()));
    expect(encuadre[0]).toBeGreaterThanOrEqual(0);
    expect(encuadre[2]).toBeLessThanOrEqual(W);
    expect(encuadre[3] - encuadre[1]).toBeGreaterThan(150);
    expect(giro).toBe(0);
  });
});

describe('Selección de réplica', () => {
  test('una réplica limpia gana a otra con mejor calidad pero con banderas graves', () => {
    const limpia = { rep: 2, puntaje: Q.selectionScore(0.93, [], { largoMin: 160 }) };
    const cortada = { rep: 0, puntaje: Q.selectionScore(0.96, ['talon_cortado'], { largoMin: 160 }) };
    expect(Q.selectReplica([cortada, limpia])).toBe(limpia);
  });

  test('empates (< 0,02): se prefiere la primera captura', () => {
    const r0 = { rep: 0, puntaje: 0.924 };
    const r2 = { rep: 2, puntaje: 0.928 };
    expect(Q.selectReplica([r2, r0])).toBe(r0);
    const r1 = { rep: 1, puntaje: 0.95 };
    expect(Q.selectReplica([r0, r1, r2])).toBe(r1);
  });

  test('el puntaje resta por pie chico y admite valores negativos', () => {
    expect(Q.selectionScore(0.9, [], { largoMin: 140 })).toBeCloseTo(0.88, 5);
    expect(Q.selectionScore(0.9, [], { largoMin: 100 })).toBeCloseTo(0.85, 5);
    const neg = Q.selectionScore(0.3, ['talon_cortado', 'pies_juntos'], {});
    expect(neg).toBeLessThan(0);
    expect(Q.selectReplica([{ rep: 0, puntaje: neg }])).toEqual({ rep: 0, puntaje: neg });
    expect(Q.selectionScore(Number.NaN, [])).toBeNull();
    expect(Q.selectReplica([{ rep: 0, puntaje: null }])).toBeNull();
  });

  test('calidad baja de la toma sólo si ninguna réplica está limpia', () => {
    const a = { rep: 0, banderas: ['poco_contraste'] };
    const b = { rep: 1, banderas: ['foto_borrosa'] };
    expect(Q.tomaQuality([a, b], b)).toMatchObject({ baja: false, limpias: 1, replicas: 2 });
    const c = { rep: 1, banderas: ['camara_lejos'] };
    expect(Q.tomaQuality([a, c], a)).toMatchObject({ baja: true, limpias: 0, banderas: ['poco_contraste'] });
    const aviso = calidadFotosAviso({ calidadFotos: Q.tomaQuality([a, c], a) });
    expect(aviso.avisos).toEqual(['Poco contraste']);
    expect(aviso.texto).toMatch(/ninguna de las 2 fotos/);
    expect(calidadFotosAviso({ calidadFotos: { baja: false } })).toBeNull();
    expect(calidadFotosAviso({})).toBeNull();
  });
});

describe('Limpieza de máscaras por forma (sin tocar temperaturas)', () => {
  const count = (m) => m.reduce((s, v) => s + (v ? 1 : 0), 0);

  test('recorta la pierna o tela pegada al talón', () => {
    const [a, b] = pair({ dy: -35 });
    const leg = Uint8Array.from(a);
    // Franja de pierna debajo del talón del pie izquierdo (ancho 30 px, hasta el borde inferior).
    // (Sólo una fuga larga, > 3,4 veces el ancho del antepié: un pie largo no se recorta.)
    const cx = Math.round(160 - 30 - 29);
    for (let y = 150; y < 240; y += 1) for (let x = cx - 15; x <= cx + 15; x += 1) leg[y * W + x] = 1;
    const before = metrics([leg, b]);
    expect(before.largoAnchoMax).toBeGreaterThan(3.4);
    const { masks, info } = cleanFeetMasks([leg, b], W, H);
    expect(info.talon).toBeGreaterThan(0);
    const after = metrics(masks);
    expect(after.largoAnchoMax).toBeLessThanOrEqual(3.45);
    // Nunca agrega píxeles que no eran del pie.
    for (let i = 0; i < leg.length; i += 1) if (masks[0][i]) expect(leg[i]).toBe(1);
    // El pie sin fuga queda igual.
    expect(count(masks[1])).toBe(count(b));
  });

  test('un pie largo (largo / ancho entre 3,0 y 3,4) no se recorta: sólo se avisa', () => {
    const masks = [ellipse(100, 120, 90, 28), ellipse(220, 120, 90, 28)];
    const m = metrics(masks);
    expect(m.largoAnchoMax).toBeGreaterThan(3.0);
    expect(m.largoAnchoMax).toBeLessThan(3.4);
    expect(Q.qualityFlags(m)).toContain('fuga_talon');
    expect(cleanFeetMasks(masks, W, H).info.cambiados).toBe(0);
  });

  test('un pie normal (sin fugas ni contacto) no cambia', () => {
    const [a, b] = pair();
    const { masks, info } = cleanFeetMasks([a, b], W, H);
    expect(info.cambiados).toBe(0);
    expect(count(masks[0])).toBe(count(a));
  });

  test('separa pies que se tocan', () => {
    const [a, b] = pair({ gap: 0 });
    expect(metrics([a, b]).puente).toBe(true);
    const { masks, info } = cleanFeetMasks([a, b], W, H);
    expect(info.contacto).toBeGreaterThan(0);
    const m = metrics(masks);
    expect(m.puente).toBe(false);
    expect(m.separacion).toBeGreaterThan(1);
  });

  test('descarta lo que cuelga por un cuello fino al costado, pero conserva los dedos', () => {
    const [a, b] = pair();
    const m = Uint8Array.from(a);
    // Mancha (tela) unida al costado del talón por un puente de 2 px.
    for (let y = 160; y < 162; y += 1) for (let x = 60; x < 75; x += 1) m[y * W + x] = 1;
    for (let y = 150; y < 172; y += 1) for (let x = 40; x < 60; x += 1) m[y * W + x] = 1;
    // Dedo frío unido a la punta por un cuello fino.
    for (let y = 36; y < 46; y += 1) m[y * W + 101] = 1;
    for (let y = 28; y < 37; y += 1) for (let x = 98; x < 105; x += 1) m[y * W + x] = 1;
    const { masks, info } = cleanFeetMasks([m, b], W, H);
    expect(info.puente).toBeGreaterThan(300);
    expect(masks[0][160 * W + 45]).toBe(0);
    expect(masks[0][30 * W + 101]).toBe(1);
  });

  test('con la limpieza, canonicalFeet sólo lee temperaturas (no las cambia)', () => {
    const { canonicalFeet } = require('../../src/imaging/pointwise');
    const masks = pair({ gap: 0 });
    const data = new Uint16Array(W * H).fill(1000);
    for (const mk of masks) for (let i = 0; i < data.length; i += 1) if (mk[i]) data[i] = 9000;
    const copy = Uint16Array.from(data);
    const cf = canonicalFeet(
      { width: W, height: H, data },
      { masks, masksSource: 'unet', limpiar: true, conMascaras: true },
    );
    expect(cf.ok).toBe(true);
    expect(cf.limpieza.contacto).toBeGreaterThan(0);
    expect(Buffer.compare(Buffer.from(data.buffer), Buffer.from(copy.buffer))).toBe(0);
    expect(cf.mascaras).toHaveLength(2);
  });
});

describe('Alineación de la foto visible por réplica', () => {
  /** Foto 640 × 480: piel clara donde cae la máscara corrida (dx, dy) px IR, fondo oscuro. */
  function photo(fg, dx, dy, { piel = 200, fondo = 40, textura = 3 } = {}) {
    const data = new Uint8Array(640 * 480 * 4);
    for (let Y = 0; Y < 480; Y += 1) {
      for (let X = 0; X < 640; X += 1) {
        const x = Math.floor((X - 80) / 1.5) - dx;
        const y = Math.floor((Y - 60) / 1.5) - dy;
        const on = x >= 0 && y >= 0 && x < W && y < H && fg[y * W + x];
        const o = (Y * 640 + X) * 4;
        // Textura suave en la piel para que la foto tenga detalle.
        const v = on ? piel + ((X + Y) % 7) * textura : fondo;
        data[o] = data[o + 1] = data[o + 2] = v;
        data[o + 3] = 255;
      }
    }
    return { width: 640, height: 480, data };
  }
  const fgOf = (masks) => masks[0].map((v, i) => (v || masks[1][i] ? 1 : 0));

  test('encuentra el desplazamiento y lo aplica si la separación piel/fondo es clara', () => {
    const fg = fgOf(pair());
    const r = alignVisible(photo(fg, 4, -2), fg);
    expect([r.dx, r.dy]).toEqual([4, -2]);
    expect(r.confiable).toBe(true);
    expect(r.aplicada).toBe(true);
    expect(r.dxFoto).toBeCloseTo(6, 5);
    expect(r.dyFoto).toBeCloseTo(-3, 5);
    expect(r.iou).toBeGreaterThan(r.iou0);
  });

  test('foto sin contraste: conserva el registro de la cámara', () => {
    const fg = fgOf(pair());
    const r = alignVisible(photo(fg, 4, -2, { piel: 90, fondo: 88 }), fg);
    expect(r.aplicada).toBe(false);
    expect(r.dxFoto).toBe(0);
    expect(r.dyFoto).toBe(0);
  });

  test('un desplazamiento grande sólo se aplica si otra réplica de la toma lo respalda', () => {
    const al = (dx, dy) => ({ dx, dy, dxFoto: dx * 1.5, dyFoto: dy * 1.5, confiable: true, aplicada: true });
    const solo = [al(-1, -15), al(-1, -5), al(-1, -6)];
    expect(reconcileShifts(solo)).toBe(1);
    expect(solo[0]).toMatchObject({ aplicada: false, dxFoto: 0, dyFoto: 0, sinRespaldo: true });
    expect(solo[1].aplicada).toBe(true);
    const coherentes = [al(-2, -8), al(-1, -9), al(0, -10)];
    expect(reconcileShifts(coherentes)).toBe(0);
    expect(coherentes.every((a) => a.aplicada)).toBe(true);
  });

  test('sin desplazamiento no se mueve la foto', () => {
    const fg = fgOf(pair());
    const r = alignVisible(photo(fg, 0, 0), fg);
    expect([r.dx, r.dy]).toEqual([0, 0]);
    expect(r.aplicada).toBe(false);
  });

  test('nitidez de la foto: la textura da varianza del laplaciano > 0; una foto lisa, ~0', () => {
    const fg = fgOf(pair());
    const p = photo(fg, 0, 0);
    const { gray } = alignVisible(p, fg);
    expect(visibleSharpness(gray, 640, 480, fg)).toBeGreaterThan(8);
    const lisa = alignVisible(photo(fg, 0, 0, { piel: 150, fondo: 150, textura: 0 }), fg).gray;
    expect(visibleSharpness(lisa, 640, 480, fg)).toBeLessThan(8);
  });
});

describe('Visor: calidad automática por réplica (fotos.json)', () => {
  test('marca la réplica elegida, los avisos, la foto realineada y la calidad baja de la toma', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termopie-fotos-'));
    fs.writeFileSync(
      path.join(dir, 'fotos.json'),
      JSON.stringify({
        replicas: {
          aaaaaaaaaaaaaaaa: { elegida: false, calidad: 0.95, banderas: ['talon_cortado'], alineacion: null },
          bbbbbbbbbbbbbbbb: {
            elegida: true,
            calidad: 0.9,
            banderas: ['poco_contraste', 'foto_borrosa'],
            alineacion: { aplicada: true, dxFoto: 4.5, dyFoto: -3 },
            encuadre: [10, 20, 300, 230],
            giro: -6,
          },
        },
        tomas: { 'P.HC999': { 1: { baja: true } } },
      }),
    );
    const maskService = {
      enabled: true,
      index: () => [
        { key: 'aaaaaaaaaaaaaaaa', codigo: 'P.HC999', toma: 1, rep: 0, calidad: 0.95 },
        { key: 'bbbbbbbbbbbbbbbb', codigo: 'P.HC999', toma: 1, rep: 1, calidad: 0.9 },
      ],
    };
    const svc = new ThermalViewerService({ maskService, fotosDir: dir });
    const study = { image: (slot) => (slot === 'toma1' ? { mime: 'image/png' } : null) };
    const [src] = await svc.sources(study, { codigo: 'P.HC999' });
    expect(src.calidadBaja).toBe(true);
    const [r1, r2] = src.reps;
    expect(r1.mejor).toBe(false);
    expect(r2.mejor).toBe(true);
    expect(r1.avisos.map((a) => a.label)).toEqual(['Talón cortado']);
    expect(r2.avisos.map((a) => a.label)).toEqual(['Poco contraste', 'Foto visible borrosa']);
    expect(r2.alineacion).toEqual({ dx: 4.5, dy: -3 });
    expect(r1.alineacion).toBeNull();
    expect(r2.encuadre).toEqual([10, 20, 300, 230]);
    expect(r2.giro).toBe(-6);
    expect(r2.evaluada).toBe(true);
  });

  test('sin fotos.json se mantiene la elección por calidad', async () => {
    const maskService = {
      enabled: true,
      index: () => [
        { key: 'aaaaaaaaaaaaaaaa', codigo: 'P.HC999', toma: 1, rep: 0, calidad: 0.8 },
        { key: 'bbbbbbbbbbbbbbbb', codigo: 'P.HC999', toma: 1, rep: 1, calidad: 0.9 },
      ],
    };
    const svc = new ThermalViewerService({ maskService, fotosDir: null });
    const study = { image: (slot) => (slot === 'toma1' ? { mime: 'image/png' } : null) };
    const [src] = await svc.sources(study, { codigo: 'P.HC999' });
    expect(src.reps.map((r) => r.mejor)).toEqual([false, true]);
    expect(src.reps[0].evaluada).toBe(false);
    expect(src.reps[0].avisos).toEqual([]);
  });
});
