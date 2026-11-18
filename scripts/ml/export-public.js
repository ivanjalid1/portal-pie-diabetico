#!/usr/bin/env node
'use strict';

/**
 * Registra a la grilla canónica del portal la base pública «Plantar Thermogram
 * Database for the Study of Diabetic Foot Complications» (Hernández-Contreras
 * D., Peregrina-Barreto H., Rangel-Magdaleno J., Renero-Carrillo F., IEEE
 * Access 7 (2019) 161296; IEEE DataPort, DOI 10.21227/tm4t-9n15; licencia
 * CC BY 4.0). 45 sujetos control (CG) y 122 con diabetes (DM); por sujeto y
 * pie, un CSV con la temperatura por píxel (°C, fondo = 0) y cuatro CSV con
 * los angiosomas MPA, LPA, MCA y LCA.
 *
 * Los archivos descargados son DATOS NO CONFIABLES: sólo se leen como texto
 * numérico (no se ejecuta nada de la descarga, p. ej. el .m de MATLAB).
 *
 * Entrada: data-local/public/hernandez2019/ThermoDataBase/ (o el primer argumento).
 * Salida (local, ignorada por git): data-local/public/hernandez2019/derived/
 *   grids.json   por sujeto: id, grupo (CG/DM), sexo, edad, IMC, grillas
 *                canónicas izq/der (base64, centésimas de °C) y los valores
 *                de la planilla de la base (temperatura por angiosoma y TCI)
 *   atlas.json   etiqueta de angiosoma mayoritaria por celda de la grilla
 *                (1 MPA, 2 LPA, 3 MCA, 4 LCA, 0 sin dato) y su acuerdo
 *
 * Con --atlas además escribe data-local/models/angiosome-atlas.json (sólo la
 * etiqueta mayoritaria por celda: un agregado, sin temperaturas ni sujetos),
 * que usa src/imaging/tci.js para ubicar los angiosomas en la grilla.
 *
 * Uso: node scripts/ml/export-public.js [carpeta] [--atlas]
 */
const fs = require('node:fs');
const path = require('node:path');
const { readXlsx } = require('../lib/xlsx');
const { GRID, encodeGrid } = require('../../src/imaging/pointwise');
const { canonicalFromCrop, parseCsvMatrix, ANGIO_KEYS } = require('../../src/imaging/footCrop');

const ROOT = path.join(__dirname, '..', '..');
const BASE = path.join(ROOT, 'data-local', 'public', 'hernandez2019');
const ARGS = process.argv.slice(2);
const DIR_ARG = ARGS.find((a) => !a.startsWith('--'));
const SRC = DIR_ARG ? path.resolve(DIR_ARG) : path.join(BASE, 'ThermoDataBase');
const ATLAS_DEST = path.join(ROOT, 'data-local', 'models', 'angiosome-atlas.json');
const OUT = path.join(BASE, 'derived');
const GRUPOS = [
  ['Control Group', 'CG'],
  ['DM Group', 'DM'],
];

const readCsv = (f) => parseCsvMatrix(fs.readFileSync(f, 'utf8'));

/** Planilla de la base: fila por sujeto con temperatura por angiosoma y TCI de cada pie. */
function readSheet(file) {
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  const sheets = readXlsx(fs.readFileSync(file));
  for (const [, rows] of sheets) {
    for (const r of rows.slice(2)) {
      const id = typeof r[0] === 'string' ? r[0].trim() : null;
      if (!id || !/^(CG|DM)\d{3}$/.test(id)) continue;
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      const pie = (k) => ({
        general: num(r[k]),
        LCA: num(r[k + 1]),
        LPA: num(r[k + 2]),
        MCA: num(r[k + 3]),
        MPA: num(r[k + 4]),
        tci: num(r[k + 5]),
      });
      out.set(id, { sexo: r[1] || null, edad: num(r[2]), imc: num(r[5]), der: pie(6), izq: pie(12) });
    }
  }
  return out;
}

function processFoot(dir, name, side) {
  const T = readCsv(path.join(dir, `${name}_${side}.csv`));
  const angio = {};
  for (const k of ANGIO_KEYS) {
    const f = path.join(dir, 'Angiosoms', `${name}_${side}_${k}.csv`);
    if (!fs.existsSync(f)) continue;
    const A = readCsv(f);
    if (A.w !== T.w || A.h !== T.h) continue;
    angio[k] = Uint8Array.from(A.data, (v) => (v > 0 ? 1 : 0));
  }
  const complete = ANGIO_KEYS.every((k) => angio[k]);
  return canonicalFromCrop(T.data, T.w, T.h, { angio: complete ? angio : null });
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`No está la base pública en ${path.relative(ROOT, SRC)}.`);
    process.exit(1);
  }
  const sheet = readSheet(path.join(SRC, 'Plantar Thermogram Database.xlsx'));
  const sujetos = [];
  const votos = Array.from({ length: GRID.w * GRID.h }, () => new Uint16Array(5));
  let espejados = 0;
  for (const [carpeta, grupo] of GRUPOS) {
    const gdir = path.join(SRC, carpeta);
    if (!fs.existsSync(gdir)) continue;
    for (const name of fs.readdirSync(gdir).sort()) {
      if (!/^(CG|DM)\d{3}_[MF]$/.test(name)) continue;
      const dir = path.join(gdir, name);
      const id = name.slice(0, 5);
      try {
        const L = processFoot(dir, name, 'L');
        const R = processFoot(dir, name, 'R');
        for (const f of [L, R]) {
          if (f.flipped) espejados += 1;
          if (f.labels) for (let i = 0; i < f.labels.length; i += 1) votos[i][f.labels[i]] += 1;
        }
        sujetos.push({
          id,
          grupo,
          sexo: name.slice(-1),
          planilla: sheet.get(id) || null,
          izq: encodeGrid(L.grid),
          der: encodeGrid(R.grid),
        });
      } catch (e) {
        console.warn(`${id}: no se pudo leer (${e.message})`);
      }
    }
  }
  // Atlas de angiosomas: etiqueta mayoritaria por celda (sólo celdas con dato en ≥ 30 % de los pies).
  const totalPies = sujetos.length * 2;
  const atlas = new Uint8Array(GRID.w * GRID.h);
  let acuerdo = 0;
  let celdas = 0;
  votos.forEach((v, i) => {
    const conDato = v[1] + v[2] + v[3] + v[4];
    if (conDato < 0.3 * totalPies) return;
    let best = 1;
    for (let k = 2; k <= 4; k += 1) if (v[k] > v[best]) best = k;
    atlas[i] = best;
    acuerdo += v[best] / conDato;
    celdas += 1;
  });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, 'grids.json'),
    JSON.stringify({
      _fuente:
        'Hernández-Contreras et al. 2019, Plantar Thermogram Database for the Study of Diabetic Foot Complications (IEEE DataPort, DOI 10.21227/tm4t-9n15), CC BY 4.0. Grillas derivadas; no versionar.',
      generado: new Date().toISOString(),
      sujetos,
    }),
  );
  fs.writeFileSync(
    path.join(OUT, 'atlas.json'),
    JSON.stringify({
      grid: GRID,
      claves: ['', ...ANGIO_KEYS],
      atlas: Array.from(atlas),
      acuerdoMedio: acuerdo / celdas,
    }),
  );
  if (ARGS.includes('--atlas')) {
    const filas = [];
    for (let r = 0; r < GRID.h; r += 1) filas.push(Array.from(atlas.slice(r * GRID.w, (r + 1) * GRID.w)).join(''));
    const doc = {
      _descripcion:
        'Atlas de angiosomas plantares en la grilla canónica (40 × 100; fila 0 = punta de los dedos, columna 0 = borde lateral). Etiqueta mayoritaria por celda de los angiosomas de la base pública Hernández-Contreras et al. 2019 (IEEE DataPort, DOI 10.21227/tm4t-9n15, CC BY 4.0), registrados con scripts/ml/export-public.js. Sólo etiquetas agregadas: sin temperaturas ni sujetos.',
      claves: { 0: 'sin dato (se usa la aproximación geométrica)', 1: 'MPA', 2: 'LPA', 3: 'MCA', 4: 'LCA' },
      pies: totalPies,
      acuerdoMedio: Math.round((acuerdo / celdas) * 1000) / 1000,
      filas,
    };
    fs.mkdirSync(path.dirname(ATLAS_DEST), { recursive: true });
    fs.writeFileSync(
      ATLAS_DEST,
      `${JSON.stringify(doc, null, 2)}
`,
    );
    console.log(`Atlas escrito en ${path.relative(ROOT, ATLAS_DEST)}`);
  }
  const n = (g) => sujetos.filter((s) => s.grupo === g).length;
  console.log(
    `Sujetos: ${sujetos.length} (CG ${n('CG')}, DM ${n('DM')}); pies espejados para dejar el medial a +x: ${espejados} de ${totalPies}.`,
  );
  console.log(`Atlas de angiosomas: ${celdas} celdas, acuerdo medio ${(acuerdo / celdas).toFixed(3)}.`);
}

main();
