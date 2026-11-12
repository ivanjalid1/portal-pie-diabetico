'use strict';

const { decodeIs2 } = require('../../src/imaging/is2');
const { analyzeThermogram, roisInCelsius, is2PreviewPng, toCelsius } = require('../../src/imaging/thermogram');
const { readZip } = require('../../src/imaging/zip');
const { fakeIs2 } = require('../helpers/is2');

describe('Decodificación de archivos IS2 (Fluke)', () => {
  it('lee el ZIP y extrae la matriz IR de 320×240 salteando la fila de cabecera', () => {
    const buf = fakeIs2();
    expect([...readZip(buf).keys()]).toContain('Images/Main/IR.data');
    const img = decodeIs2(buf);
    expect(img.width).toBe(320);
    expect(img.height).toBe(240);
    expect(img.data.length).toBe(320 * 240);
    expect(img.data[125 * 320 + 100]).toBeGreaterThan(4800); // pie
    expect(img.data[10 * 320 + 10]).toBeLessThan(4300); // fondo
  });

  it('rechaza un ZIP sin IR.data', () => {
    expect(() => decodeIs2(Buffer.from('PK\u0005\u0006' + '\0'.repeat(18), 'binary'))).toThrow();
  });

  it('segmenta ambos pies y estima temperaturas por ROI (pie izquierdo a la izquierda de la imagen)', () => {
    const a = analyzeThermogram(decodeIs2(fakeIs2({ asym: 200 })));
    expect(a.ok).toBe(true);
    const rois = roisInCelsius(a);
    expect(rois).toHaveLength(7);
    const dedo = rois.find((r) => r.roi === 'dedo_mayor');
    expect(dedo.deltaT).toBeGreaterThan(1);
    expect(dedo.avgDer).toBeGreaterThan(toCelsius(4850));
  });

  it('genera una vista previa PNG sin metadatos', () => {
    const png = is2PreviewPng(fakeIs2(), { width: 320, height: 240 });
    expect(png.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(png.includes(Buffer.from('tEXt'))).toBe(false);
    expect(png.includes(Buffer.from('eXIf'))).toBe(false);
  });
});
