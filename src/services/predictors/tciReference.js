'use strict';

/**
 * Patrón de referencia para el TCI (src/imaging/tci.js).
 *
 * Fuente actual: los pacientes MÁS SIMÉTRICOS de la cohorte, a falta de un
 * grupo control propio. Criterio (toma 1):
 *  - no marcado «no válido» en la planilla y segmentación sin aviso (calidad ≥ 0,6);
 *  - |ΔT general| < 1 °C según la planilla de la Parte 1 (hoja «DifT°»);
 *  - área con |ΔT| > 1 °C menor al 10 % en el análisis punto a punto.
 * El criterio NO usa el desenlace (HbA1c ni lesiones), así que no filtra
 * información del desenlace al índice. Al puntuar a un miembro de la
 * referencia se lo excluye (leave-one-out).
 *
 * Los miembros (grillas canónicas) se guardan sólo en local
 * (data-local/real/tci-reference.json). Sin esa carpeta (demo, CI, Vercel)
 * se arma una referencia de DEMOSTRACIÓN con la toma 1 de los pares demo
 * anonimizados (src/seed/demoPointwise.json).
 *
 * Punto de extensión: `fuente: 'hernandez2019'` (base pública de
 * Hernández-Contreras et al. 2019) — ver REFERENCE_SOURCES en tci.js.
 */
const fs = require('node:fs');
const path = require('node:path');
const { decodeGrid, asymmetryMetrics, zoneCoverage } = require('../../imaging/pointwise');
const { buildReference, REFERENCE_SOURCES } = require('../../imaging/tci');

const REFERENCE_FILE = 'tci-reference.json';

const CRITERIO_COHORTE = Object.freeze({
  maxDeltaGeneral: 1,
  maxAreaCaliente: 10,
  minCalidad: 0.6,
  umbralPixel: 1,
});

/** Zonas con cobertura < 50 % (igual que analyzePointwise). */
function zonasExcluidas(izq, der) {
  return Object.entries(zoneCoverage(izq, der))
    .filter(([, v]) => v < 0.5)
    .map(([k]) => k);
}

/**
 * Elige los miembros de la referencia entre los pacientes del dataset
 * precalculado (formato de scripts/precompute-real.js).
 * @returns {Array<{id:string, izq:string, der:string}>} grillas en base64
 */
function selectReferenceMembers(pacientes, criterio = CRITERIO_COHORTE) {
  const out = [];
  for (const p of pacientes) {
    if (p.clinica?.noValido) continue;
    const t1 = p.tomas?.find((t) => t.toma === 1 && t.ok);
    if (!t1 || (t1.calidad ?? 0) < criterio.minCalidad) continue;
    const gen = p.ana?.rois?.find((r) => r.roi === 'general');
    if (!gen || Math.abs(gen.avgDer - gen.avgIzq) >= criterio.maxDeltaGeneral) continue;
    const izq = decodeGrid(t1.izq);
    const der = decodeGrid(t1.der);
    const m = asymmetryMetrics(izq, der, {
      umbralPixel: criterio.umbralPixel,
      zonasExcluidas: zonasExcluidas(izq, der),
    });
    if (!m || m.areaCalientePct >= criterio.maxAreaCaliente) continue;
    out.push({ id: p.codigo, izq: t1.izq, der: t1.der });
  }
  return out;
}

const decodeMembers = (members) => members.map((m) => ({ id: m.id, izq: decodeGrid(m.izq), der: decodeGrid(m.der) }));

/** Referencia de demostración: toma 1 de los pares demo (sin datos reales). */
function demoStore() {
  const { pares } = require('../../seed/demoPointwise.json');
  const members = pares
    .filter((p) => p.toma1?.izq)
    .map((p) => ({ id: `demo-${p.par}`, izq: p.toma1.izq, der: p.toma1.der }));
  return {
    fuente: 'demo',
    descripcion: 'Referencia de demostración (pares demo anonimizados); sin valor clínico.',
    members: decodeMembers(members),
  };
}

/**
 * Carga el almacén de miembros de la referencia: el real (local) si existe en
 * `dir`, si no el de demostración.
 */
function loadReferenceStore(dir = null) {
  const file = dir ? path.join(dir, REFERENCE_FILE) : null;
  if (file && fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        fuente: data.fuente || 'cohorte',
        descripcion: REFERENCE_SOURCES[data.fuente || 'cohorte'],
        criterio: data.criterio || null,
        members: decodeMembers(data.miembros || []),
      };
    } catch {
      // archivo dañado: se usa la referencia de demostración
    }
  }
  return demoStore();
}

/**
 * Referencia lista para `computeTci`, con exclusión leave-one-out. La de
 * todos los miembros se cachea en el almacén.
 */
function referenceFor(store, exclude = null) {
  if (!store?.members?.length) return null;
  const esMiembro = exclude !== null && store.members.some((m) => m.id === exclude);
  if (!esMiembro) {
    if (!store._all) store._all = buildReference(store.members, { fuente: store.fuente });
    return store._all;
  }
  return buildReference(store.members, { exclude, fuente: store.fuente });
}

module.exports = {
  REFERENCE_FILE,
  CRITERIO_COHORTE,
  selectReferenceMembers,
  loadReferenceStore,
  referenceFor,
  demoStore,
};
