'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeThermal, decodeThermal, grayToCelsius, NODATA } = require('../../src/imaging/thermalArray');
const { encodePng, decodePng } = require('../../src/imaging/png');
const { extractVisible, is2Info, hasVisible, parseGpb, FUSION } = require('../../src/imaging/is2');
const { ThermalViewerService, is2Key } = require('../../src/services/ThermalViewerService');
const { is2Key: scriptsKey } = require('../../scripts/lib/npy');
const { VIEWER_LUTS } = require('../../src/utils/thermal');
const { fakeIs2, gpb } = require('../helpers/is2');

describe('Matriz de temperaturas compacta (TPV1)', () => {
  test('ida y vuelta con paso de 0,01 °C y sin dato', () => {
    const data = Float32Array.from([22.345, 30, Number.NaN, 35.678, 18.01, 41]);
    const buf = encodeThermal({ width: 3, height: 2, data });
    expect(buf.toString('ascii', 0, 4)).toBe('TPV1');
    expect(buf.length).toBe(16 + 6 * 2);
    expect(buf.readUInt16LE(16 + 2 * 2)).toBe(NODATA);
    const out = decodeThermal(buf);
    expect(out.width).toBe(3);
    expect(out.height).toBe(2);
    expect(Number.isNaN(out.data[2])).toBe(true);
    for (const i of [0, 1, 3, 4, 5]) expect(Math.abs(out.data[i] - data[i])).toBeLessThanOrEqual(0.0051);
  });

  test('rechaza tamaños inconsistentes y firmas desconocidas', () => {
    expect(() => encodeThermal({ width: 2, height: 2, data: new Float32Array(3) })).toThrow();
    expect(() => decodeThermal(Buffer.from('XXXX0000000000000000'))).toThrow();
  });

  test('reconstruye °C desde un render en grises con escala conocida', () => {
    const w = 8;
    const h = 6;
    const rgb = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i += 1) rgb.fill(i % w < 4 ? 0 : 255, i * 3, i * 3 + 3);
    const png = decodePng(encodePng(w, h, rgb));
    expect(png.channels).toBe(3);
    const T = grayToCelsius(png, { min: 20, max: 34 }, { width: 4, height: 3 });
    expect(T.data[0]).toBeCloseTo(20, 5);
    expect(T.data[3]).toBeCloseTo(34, 5);
  });

  test('las LUT del visor tienen 256 colores RGB por paleta', () => {
    for (const k of ['alto_contraste', 'ironbow', 'grises']) expect(VIEWER_LUTS[k]).toHaveLength(768);
    expect(VIEWER_LUTS.grises.slice(-3)).toEqual([255, 255, 255]);
  });
});

describe('IS2: foto visible y metadatos de captura', () => {
  test('extrae la foto completa re-codificada y el registro fijo IR → visible', () => {
    const is2 = fakeIs2({ visible: true });
    expect(hasVisible(is2)).toBe(true);
    const v = extractVisible(is2);
    expect(v.width).toBe(640);
    expect(v.height).toBe(480);
    expect(v.jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(FUSION).toMatchObject({ x: 80, y: 60, scale: 1.5 });
    expect(FUSION.x * 2 + 320 * FUSION.scale).toBe(640);
  });

  test('sin foto visible devuelve null', () => {
    const is2 = fakeIs2();
    expect(hasVisible(is2)).toBe(false);
    expect(extractVisible(is2)).toBeNull();
  });

  test('metadatos no identificatorios (sin número de serie)', () => {
    const info = is2Info(fakeIs2({ visible: true }));
    expect(info).toMatchObject({
      camara: 'Fluke TiS75',
      emisividad: 0.97,
      fondoC: 22,
      transmision: 100,
      escalaCamara: { min: 24, max: 35 },
      visible: { width: 640, height: 480 },
    });
    expect(JSON.stringify(info)).not.toMatch(/00000000/);
  });

  test('parser protobuf genérico', () => {
    const m = parseGpb(Buffer.concat([gpb(10, 0.5), gpb(3, Buffer.from('ab'))]));
    expect(m.get(10)[0]).toBeCloseTo(0.5);
    expect(m.get(3)[0].toString()).toBe('ab');
  });
});

describe('ThermalViewerService', () => {
  test('la clave del IS2 coincide con la de los scripts de ML', () => {
    const root = path.join(os.tmpdir(), 'raiz');
    const file = path.join(root, 'A', 'B', 'IR_0001.IS2');
    expect(is2Key(root, file)).toBe(scriptsKey(root, file));
  });

  test('sin carpeta privada no hay fotos visibles', () => {
    const svc = new ThermalViewerService({ privateDir: null });
    expect(svc.visibleEnabled).toBe(false);
    expect(svc.visibleByKey('0123456789abcdef')).toBeNull();
  });

  test('con carpeta privada resuelve la foto de una réplica por su clave', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termopie-priv-'));
    const file = path.join(dir, 'X', 'IR_0001.IS2');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fakeIs2({ visible: true }));
    const svc = new ThermalViewerService({ privateDir: dir });
    const key = is2Key(dir, file);
    expect(svc.hasVisibleKey(key)).toBe(true);
    expect(svc.visibleByKey(key).subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(svc.infoByKey(key).camara).toBe('Fluke TiS75');
  });
});
