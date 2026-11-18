#!/usr/bin/env node
'use strict';

/**
 * Exporta las features invariantes a la adquisición (src/imaging/thermalPattern.js)
 * de la base pública 2019 y de la cohorte, con las MISMAS funciones que usa el
 * portal, para scripts/ml/train_public.py y scripts/ml/train_adjusted.py.
 *
 * Entradas (locales):
 *   data-local/public/hernandez2019/derived/grids.json  (scripts/ml/export-public.js)
 *   data-local/real/dataset.json                         (npm run precompute:real)
 * Salidas (locales, ignoradas por git):
 *   data-local/ml/pattern-public.json   fila por sujeto: id, dm (1/0), sexo, edad,
 *                                       IMC, TCI de la planilla de la base, features
 *   data-local/ml/pattern-public.npy    float32 (n, 3, 100, 40): T − mediana del pie
 *                                       izquierdo y del derecho, máscara (ambos con dato)
 *   data-local/ml/pattern-cohorte.json  fila por paciente con toma 1 analizable:
 *                                       código (sólo para agrupar), centro, desenlaces,
 *                                       «no válido», TCI contra la referencia y features
 *   data-local/ml/pattern-cohorte.npy   ídem mapas de la cohorte
 * No se exportan nombres ni datos identificatorios.
 */
const fs = require('node:fs');
const path = require('node:path');
const { writeNpy } = require('../lib/npy');
const { decodeGrid, GRID } = require('../../src/imaging/pointwise');
const { patternFeatures } = require('../../src/imaging/thermalPattern');
const { sinConsentimiento } = require('../../src/seed/realData');
const { PUBLIC_GRIDS } = require('../../src/services/predictors/tciReference');

const ROOT = path.join(__dirname, '..', '..');
const DATASET = path.join(ROOT, 'data-local', 'real', 'dataset.json');
const OUT = path.join(ROOT, 'data-local', 'ml');

function median(g) {
  const v = [...g].filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : NaN;
}

/** Mapas (3 × 100 × 40): relativo izq., relativo der., máscara de celdas con dato en ambos. */
function relMaps(izq, der) {
  const mi = median(izq);
  const md = median(der);
  const n = GRID.w * GRID.h;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i += 1) {
    const a = Number.isFinite(izq[i]);
    const b = Number.isFinite(der[i]);
    if (a) out[i] = izq[i] - mi;
    if (b) out[n + i] = der[i] - md;
    out[2 * n + i] = a && b ? 1 : 0;
  }
  return out;
}

function exportPublic() {
  if (!fs.existsSync(PUBLIC_GRIDS)) {
    console.warn('Sin base pública (node scripts/ml/export-public.js): se omite.');
    return;
  }
  const { sujetos } = JSON.parse(fs.readFileSync(PUBLIC_GRIDS, 'utf8'));
  const filas = [];
  const maps = [];
  for (const s of sujetos) {
    const izq = decodeGrid(s.izq);
    const der = decodeGrid(s.der);
    const features = patternFeatures(izq, der);
    if (!features) continue;
    const pl = s.planilla || {};
    const tcis = [pl.izq?.tci, pl.der?.tci].filter(Number.isFinite);
    filas.push({
      id: s.id,
      fila: filas.length,
      dm: s.grupo === 'DM' ? 1 : 0,
      sexo: s.sexo,
      edad: pl.edad ?? null,
      imc: pl.imc ?? null,
      tciBase: tcis.length ? tcis.reduce((a, b) => a + b, 0) / tcis.length : null,
      generalBase: [pl.izq?.general, pl.der?.general].filter(Number.isFinite),
      features,
    });
    maps.push(relMaps(izq, der));
  }
  fs.writeFileSync(path.join(OUT, 'pattern-public.json'), JSON.stringify(filas));
  const flat = new Float32Array(maps.length * maps[0].length);
  maps.forEach((m, k) => flat.set(m, k * m.length));
  writeNpy(path.join(OUT, 'pattern-public.npy'), flat, [maps.length, 3, GRID.h, GRID.w]);
  console.log(`Base pública: ${filas.length} sujetos (DM ${filas.filter((f) => f.dm).length}).`);
}

function exportCohorte() {
  if (!fs.existsSync(DATASET)) {
    console.warn('Sin data-local/real/dataset.json (npm run precompute:real): se omite la cohorte.');
    return;
  }
  const { pacientes } = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
  const filas = [];
  const maps = [];
  for (const p of pacientes) {
    if (sinConsentimiento(p)) continue;
    const t1 = p.tomas.find((t) => t.toma === 1 && t.ok);
    if (!t1) continue;
    const izq = decodeGrid(t1.izq);
    const der = decodeGrid(t1.der);
    const features = patternFeatures(izq, der);
    if (!features) continue;
    const c = p.clinica || {};
    const bin = (v) => (v === null || v === undefined ? null : v ? 1 : 0);
    filas.push({
      fila: filas.length,
      grupo: p.codigo,
      centro: p.centro,
      noValido: Boolean(c.noValido),
      calidad: t1.calidad,
      segmentacion: t1.segmentacion || 'clasica',
      desenlaces: {
        hba1c7: c.hba1c === null || c.hba1c === undefined ? null : c.hba1c > 7 ? 1 : 0,
        lesion: bin(c.generoLesion),
      },
      tci: t1.tci?.valor ?? null,
      tciPatron: t1.tci?.patron ?? null,
      tciFuente: t1.tci?.referencia?.fuente ?? null,
      features,
    });
    maps.push(relMaps(izq, der));
  }
  fs.writeFileSync(path.join(OUT, 'pattern-cohorte.json'), JSON.stringify(filas));
  if (maps.length) {
    const flat = new Float32Array(maps.length * maps[0].length);
    maps.forEach((m, k) => flat.set(m, k * m.length));
    writeNpy(path.join(OUT, 'pattern-cohorte.npy'), flat, [maps.length, 3, GRID.h, GRID.w]);
  }
  console.log(`Cohorte: ${filas.length} pacientes con toma 1 analizable.`);
}

fs.mkdirSync(OUT, { recursive: true });
exportPublic();
exportCohorte();
