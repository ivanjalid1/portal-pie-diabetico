#!/usr/bin/env node
'use strict';

/**
 * Exporta la tabla de features y los mapas registrados para comparar modelos
 * (scripts/ml/train_models.py). Usa EXACTAMENTE las mismas funciones que el
 * portal (src/imaging/pointwise.js, src/imaging/tci.js), así las features de
 * entrenamiento y de uso coinciden.
 *
 * Entrada: data-local/real/dataset.json (npm run precompute:real).
 * Salida (local):
 *   data-local/ml/features.json  una fila por paciente con toma 1 analizable:
 *     id (índice anónimo), grupo (= paciente, para la validación cruzada),
 *     desenlaces disponibles, exclusiones y features de la toma 1 (+ cambio
 *     entre tomas si existe la toma 2)
 *   data-local/ml/maps.npy  float32 (n, 4, 100, 40): ΔT izq − der, desvío TCI
 *     del pie izquierdo, desvío TCI del derecho, máscara de celdas con dato.
 *     Sin dato → 0.
 *
 * Desenlaces (configurables en train_models.py --outcome):
 *   hba1c7 : HbA1c > 7 % (sustituto de la Parte 1)
 *   lesion : «generó lesión» en el seguimiento (planilla; en el portal, el
 *            «Desenlace real» que registra el médico)
 */
const fs = require('node:fs');
const path = require('node:path');
const { writeNpy } = require('../lib/npy');
const { decodeGrid, diffGrid, GRID } = require('../../src/imaging/pointwise');
const { analyzePointwise } = require('../../src/services/predictors/pointwiseAnalysis');
const { sinConsentimiento } = require('../../src/seed/realData');

const ROOT = path.join(__dirname, '..', '..');
const DATASET = path.join(ROOT, 'data-local', 'real', 'dataset.json');
const OUT = path.join(ROOT, 'data-local', 'ml');

function main() {
  if (!fs.existsSync(DATASET)) {
    console.error('Falta data-local/real/dataset.json (npm run precompute:real).');
    process.exit(1);
  }
  const { pacientes } = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
  const filas = [];
  const maps = [];
  for (const p of pacientes) {
    if (sinConsentimiento(p)) continue;
    const t1 = p.tomas.find((t) => t.toma === 1 && t.ok);
    if (!t1) continue;
    const t2 = p.tomas.find((t) => t.toma === 2 && t.ok) || null;
    const a = analyzePointwise({ toma1: t1, ...(t2 ? { toma2: t2 } : {}) }, { umbralPixel: 1, areaMinima: 10 });
    const m = a.tomas[0].metricas;
    if (!m) continue;
    const tci = t1.tci || {};
    const cambio = a.cambio;
    const fila = {
      id: filas.length,
      grupo: p.codigo,
      noValido: Boolean(p.clinica?.noValido),
      desenlaces: {
        hba1c7: p.clinica?.hba1c === null || p.clinica?.hba1c === undefined ? null : p.clinica.hba1c > 7 ? 1 : 0,
        lesion:
          p.clinica?.generoLesion === null || p.clinica?.generoLesion === undefined
            ? null
            : p.clinica.generoLesion
              ? 1
              : 0,
      },
      segmentacion: t1.segmentacion || 'clasica',
      calidad: t1.calidad,
      features: {
        areaCalientePct: m.areaCalientePct,
        mediaAbs: m.mediaAbs,
        p95Abs: m.p95Abs,
        tci: tci.valor ?? null,
        tciPuntual: tci.puntual ?? null,
        tciPatron: tci.patron ?? null,
        cambioP95: cambio ? Math.max(cambio.izq?.p95Abs ?? 0, cambio.der?.p95Abs ?? 0) : null,
        cambioLocalPct: cambio
          ? Math.max(cambio.izq?.areaCambioLocalPct ?? 0, cambio.der?.areaCambioLocalPct ?? 0)
          : null,
      },
    };
    filas.push(fila);
    const izq = decodeGrid(t1.izq);
    const der = decodeGrid(t1.der);
    const dt = diffGrid(izq, der);
    const di = tci.mapas ? decodeGrid(tci.mapas.izq) : new Float32Array(dt.length).fill(NaN);
    const dd = tci.mapas ? decodeGrid(tci.mapas.der) : new Float32Array(dt.length).fill(NaN);
    for (const ch of [dt, di, dd]) maps.push(...Array.from(ch, (v) => (Number.isFinite(v) ? v : 0)));
    maps.push(...Array.from(dt, (v) => (Number.isFinite(v) ? 1 : 0)));
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'features.json'), JSON.stringify(filas));
  writeNpy(path.join(OUT, 'maps.npy'), Float32Array.from(maps), [filas.length, 4, GRID.h, GRID.w]);
  const conT2 = filas.filter((f) => f.features.cambioP95 !== null).length;
  const seg = filas.filter((f) => f.segmentacion === 'unet').length;
  console.log(`Filas: ${filas.length} (con toma 2: ${conT2}; segmentación U-Net: ${seg}).`);
}

main();
