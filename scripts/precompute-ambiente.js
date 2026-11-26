#!/usr/bin/env node
'use strict';

/**
 * Condiciones ambientales de cada toma de los pacientes reales (temperatura de
 * la sala y humedad relativa), para el loader de datos reales
 * (src/seed/realData.js), tanto local (SEED=real) como en Supabase.
 *
 * Fuentes:
 *  - Toma 1: la planilla clínica «(3)», hoja «Contactos». El ambiente está
 *    escrito a mano en cada bloque de paciente, en la columna de la fecha:
 *    «23,5°» y la humedad como fracción (0,65).
 *  - Toma 2: «docs/Planillas clinicas temperatura segunda toma.xlsx», hoja
 *    «Hoja 3». Hay tres grupos de 5 columnas (Córdoba, Reina Fabiola, Ferreyra):
 *    paciente (NOMBRE, sin código) | t máx | t mín | humedad | fecha. Se asocia
 *    por nombre, igual que el inventario de precompute-real.js; si no, por
 *    similitud dentro del mismo centro. Sala = (t máx + t mín) / 2.
 *  - Sin dato medido: se ESTIMA con los píxeles de fondo del termograma
 *    (mediana de los píxeles a más de 20 px de la máscara de los pies y más
 *    fríos que la mediana del pie − 3 °C; mediana entre réplicas). Calibración
 *    contra las tomas medidas: sala ≈ 0,99 · fondo − 1,55 (LOO MAE 0,74 °C).
 *
 * Salida: data-local/real/ambiente.json, SÓLO con códigos (sin nombres). El
 * script no imprime nombres: sólo conteos.
 *
 * Uso: node scripts/precompute-ambiente.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { readXlsx, excelDate } = require('./lib/xlsx');
const { readNpy } = require('../src/utils/npy');
const { parseCode, PLANILLA } = require('./precompute-real');

const ROOT = path.join(__dirname, '..');
const TOMA2 = path.join(ROOT, 'docs', 'Planillas clinicas temperatura segunda toma.xlsx');
const LOCAL = path.join(ROOT, 'data-local');
const CACHE = path.join(LOCAL, 'ml', 'cache');
const UNET = path.join(LOCAL, 'ml', 'unet-masks');
const OUT = path.join(LOCAL, 'real', 'ambiente.json');

/** Calibración del estimador por el fondo (engram analysis/ambient-conditions). */
const ESTIMADOR = Object.freeze({ a: 0.99, b: -1.55, errorC: 0.7, distanciaPx: 20, margenC: 3 });
const SITES = { HC: 'Hospital Córdoba', RF: 'Clínica Reina Fabiola', VHF: 'Hospital Ferreyra' };
const GRUPOS_T2 = [
  [0, 'Hospital Córdoba'],
  [6, 'Clínica Reina Fabiola'],
  [12, 'Hospital Ferreyra'],
];

const siteOf = (codigo) => SITES[/^P\.([A-Z]+)/.exec(codigo)?.[1]] || null;
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);

/** «23,5°» o 23.5 → °C (12–32), si no null. */
function numTemp(v) {
  if (typeof v === 'number') return v >= 12 && v <= 32 ? v : null;
  if (typeof v === 'string' && v.includes('°')) {
    const m = /(\d+(?:\.\d+)?)/.exec(v.trim().replace('°,', '.').replace(',', '.'));
    if (m) {
      const x = Number(m[1]);
      return x >= 12 && x <= 32 ? x : null;
    }
  }
  return null;
}
const numRh = (v) => (typeof v === 'number' && v >= 0.15 && v <= 0.99 ? v * 100 : null);

/** Bloques «ID PACIENTE» de la hoja Contactos: tokens del nombre y ambiente de la toma 1. */
function readContactBlocks(sheets) {
  const rows = sheets.get('Contactos') || [];
  const out = new Map();
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c += 1) {
      if (typeof row[c] !== 'string' || !/^ID PACIENTE/i.test(row[c].trim())) continue;
      const codigo = parseCode(row[c + 1]);
      if (!codigo) continue;
      let alto = 1;
      while (alto < 4) {
        const v = (rows[r + alto] || [])[c];
        if (typeof v === 'string' && /^ID PACIENTE/i.test(v.trim())) break;
        alto += 1;
      }
      const nombre = alto > 1 ? (rows[r + 1] || [])[c + 1] : null;
      const col = Array.from({ length: alto }, (_, dr) => (rows[r + dr] || [])[c + 2]);
      out.set(codigo, {
        tokens: new Set(typeof nombre === 'string' ? norm(nombre) : []),
        fecha: col.map((v) => (typeof v === 'number' ? excelDate(v) : null)).find(Boolean) || null,
        tempC: col.map(numTemp).find((v) => v !== null) ?? null,
        humedad: col.map(numRh).find((v) => v !== null) ?? null,
      });
    }
  }
  return out;
}

/** Asociación estricta por nombre (misma regla que precompute-real.js#inventory). */
function matchName(name, contacts) {
  const t = norm(name);
  const scored = [...contacts.entries()]
    .map(([codigo, p]) => ({ codigo, n: t.filter((x) => p.tokens.has(x)).length }))
    .filter((s) => s.n > 0)
    .sort((a, b) => b.n - a.n);
  if (!scored.length) return null;
  const n0 = scored[0].n;
  const ok =
    (n0 >= 2 || (n0 === 1 && t.length === 1 && scored.filter((s) => s.n === 1).length === 1)) &&
    (scored.length === 1 || scored[1].n < n0);
  return ok ? scored[0].codigo : null;
}

/** Similitud normalizada (1 − Levenshtein / largo máximo). */
function ratio(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/** Filas de la hoja de la toma 2 (el nombre sólo se usa en memoria para asociar). */
function readToma2(sheets) {
  const rows = sheets.get('Hoja 3') || [];
  const out = [];
  for (const [c0, site] of GRUPOS_T2) {
    for (let r = 0; r < rows.length; r += 1) {
      const row = rows[r] || [];
      const name = row[c0];
      if (typeof name !== 'string' || !name.trim() || /paciente/i.test(name)) continue;
      const vals = [1, 2, 3, 4].map((k) => row[c0 + k]);
      let [tmax, tmin, rh] = vals;
      const fecha = vals[3];
      tmax = typeof tmax === 'number' ? tmax : null;
      tmin = typeof tmin === 'number' ? tmin : null;
      // Error de tipeo conocido (p. ej. 210,9 por 21,09).
      if (tmax !== null && tmax > 35) tmax /= 10;
      if (tmax !== null && tmax > 35) tmax /= 10;
      if (tmin !== null && tmin > 35) tmin /= 10;
      rh = typeof rh === 'number' ? (rh < 1.5 ? rh * 100 : rh) : null;
      out.push({ name, site, tmax, tmin, rh, fecha: typeof fecha === 'number' ? excelDate(fecha) : null });
    }
  }
  return out;
}

/* ---------------- Estimador por el fondo del termograma ---------------- */

/** Distancia (chaflán 1/√2) de cada píxel a la máscara. */
function distanceToMask(mask, w, h) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i += 1) d[i] = mask[i] ? 0 : INF;
  const D = Math.SQRT2;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
      if (y > 0) {
        d[i] = Math.min(d[i], d[i - w] + 1);
        if (x > 0) d[i] = Math.min(d[i], d[i - w - 1] + D);
        if (x < w - 1) d[i] = Math.min(d[i], d[i - w + 1] + D);
      }
    }
  }
  for (let y = h - 1; y >= 0; y -= 1) {
    for (let x = w - 1; x >= 0; x -= 1) {
      const i = y * w + x;
      if (x < w - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
      if (y < h - 1) {
        d[i] = Math.min(d[i], d[i + w] + 1);
        if (x < w - 1) d[i] = Math.min(d[i], d[i + w + 1] + D);
        if (x > 0) d[i] = Math.min(d[i], d[i + w - 1] + D);
      }
    }
  }
  return d;
}

const median = (arr) => {
  if (!arr.length) return null;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Temperatura de fondo (°C) de una réplica exportada, o null. */
function backgroundOf(key) {
  const tFile = path.join(CACHE, `${key}_t.npy`);
  if (!fs.existsSync(tFile)) return null;
  const T = readNpy(tFile);
  const [h, w] = T.shape;
  const mFile = fs.existsSync(path.join(UNET, `${key}.npy`))
    ? path.join(UNET, `${key}.npy`)
    : path.join(CACHE, `${key}_cls.npy`);
  if (!fs.existsSync(mFile)) return null;
  const M = Uint8Array.from(readNpy(mFile).data, (v) => (v > 0 ? 1 : 0));
  const foot = [];
  for (let i = 0; i < M.length; i += 1) if (M[i]) foot.push(T.data[i]);
  if (foot.length < 500) return null;
  const footMed = median(foot);
  const dist = distanceToMask(M, w, h);
  const bg = [];
  for (let i = 0; i < M.length; i += 1) {
    if (dist[i] > ESTIMADOR.distanciaPx && T.data[i] < footMed - ESTIMADOR.margenC) bg.push(T.data[i]);
  }
  return bg.length > 300 ? median(bg) : null;
}

function main() {
  if (!fs.existsSync(PLANILLA)) {
    console.error('Falta la planilla clínica en tesis-2026info/. No se generó nada.');
    process.exit(1);
  }
  const dataset = JSON.parse(fs.readFileSync(path.join(LOCAL, 'real', 'dataset.json'), 'utf8'));
  const contacts = readContactBlocks(readXlsx(fs.readFileSync(PLANILLA)));
  const filas2 = fs.existsSync(TOMA2) ? readToma2(readXlsx(fs.readFileSync(TOMA2))) : [];
  const index = fs.existsSync(path.join(CACHE, 'index.json'))
    ? JSON.parse(fs.readFileSync(path.join(CACHE, 'index.json'), 'utf8')).filter((e) => e.exportado)
    : [];

  const tomasDe = new Map(dataset.pacientes.map((p) => [p.codigo, p.tomas.filter((t) => t.ok)]));
  // Toma 2: asociación estricta; luego, para los que quedan, por similitud en el mismo centro.
  const t2 = new Map();
  const sinAsociar = [];
  for (const f of filas2) {
    const codigo = parseCode(f.name) || matchName(f.name, contacts);
    if (codigo && !t2.has(codigo)) t2.set(codigo, { ...f, asociacion: 'nombre' });
    else if (!codigo) sinAsociar.push(f);
  }
  let porSimilitud = 0;
  for (const f of sinAsociar) {
    const t = norm(f.name);
    const cand = [];
    for (const [codigo, p] of contacts) {
      if (siteOf(codigo) !== f.site || t2.has(codigo)) continue;
      if (!tomasDe.get(codigo)?.some((x) => x.toma === 2)) continue;
      const n = t.filter((a) => [...p.tokens].some((b) => ratio(a, b) >= 0.8)).length;
      if (n) cand.push({ codigo, n });
    }
    cand.sort((a, b) => b.n - a.n);
    if (!cand.length || (cand.length > 1 && cand[1].n === cand[0].n)) continue;
    const best = cand[0];
    // Con un solo token parecido se exige además que la fecha de la planilla coincida con la de la cámara (±3 días).
    const fechaIs2 = tomasDe
      .get(best.codigo)
      .find((x) => x.toma === 2)
      ?.fecha?.slice(0, 10);
    const dias = f.fecha && fechaIs2 ? Math.abs((new Date(fechaIs2) - new Date(f.fecha)) / 86400000) : null;
    if (best.n >= 2 || (dias !== null && dias <= 3)) {
      t2.set(best.codigo, { ...f, asociacion: 'similitud' });
      porSimilitud += 1;
    }
  }

  const keysDe = new Map();
  for (const e of index) {
    const k = `${e.codigo}|${e.toma}`;
    keysDe.set(k, [...(keysDe.get(k) || []), e.key]);
  }

  const pacientes = {};
  const resumen = { 1: { medida: 0, estimada: 0, sinDato: 0 }, 2: { medida: 0, estimada: 0, sinDato: 0 } };
  for (const p of dataset.pacientes) {
    for (const t of tomasDe.get(p.codigo) || []) {
      const bgs = (keysDe.get(`${p.codigo}|${t.toma}`) || []).map(backgroundOf).filter((v) => v !== null);
      const fondoC = bgs.length ? median(bgs) : null;
      let reg = null;
      if (t.toma === 1) {
        const c = contacts.get(p.codigo);
        if (c && c.tempC !== null)
          reg = { tempC: r1(c.tempC), humedad: r1(c.humedad), origen: 'medida', fuente: 'planilla-contactos' };
      } else {
        const f = t2.get(p.codigo);
        if (f && (f.tmax !== null || f.tmin !== null)) {
          const temp = f.tmax !== null && f.tmin !== null ? (f.tmax + f.tmin) / 2 : (f.tmax ?? f.tmin);
          reg = {
            tempC: r1(temp),
            humedad: r1(f.rh),
            origen: 'medida',
            fuente: f.asociacion === 'nombre' ? 'planilla-toma2' : 'planilla-toma2-similitud',
          };
        }
      }
      if (!reg && fondoC !== null) {
        reg = {
          tempC: r1(ESTIMADOR.a * fondoC + ESTIMADOR.b),
          humedad: null,
          origen: 'estimada',
          fuente: 'fondo-termograma',
          errorC: ESTIMADOR.errorC,
        };
      }
      if (reg) {
        reg.fondoC = r1(fondoC);
        pacientes[p.codigo] = { ...(pacientes[p.codigo] || {}), [t.toma]: reg };
        resumen[t.toma][reg.origen] += 1;
      } else resumen[t.toma].sinDato += 1;
    }
  }
  fs.writeFileSync(
    OUT,
    `${JSON.stringify({ generado: new Date().toISOString(), estimador: ESTIMADOR, pacientes }, null, 1)}\n`,
  );
  console.log(
    `Ambiente por toma — toma 1: ${JSON.stringify(resumen[1])} · toma 2: ${JSON.stringify(resumen[2])} ` +
      `(toma 2 asociada por similitud: ${porSimilitud}; filas de la hoja de toma 2: ${filas2.length})`,
  );
  console.log(`Salida: ${path.relative(ROOT, OUT)}`);
}

module.exports = { numTemp, numRh, norm, ratio, distanceToMask, ESTIMADOR };

if (require.main === module) main();
