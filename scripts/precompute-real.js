#!/usr/bin/env node
'use strict';

/**
 * Precalcula el análisis punto a punto de TODOS los pacientes reales a partir
 * de la carpeta privada `tesis-2026info/` (no versionada) y deja el resultado
 * en `data-local/real/` (también ignorada por git y por Vercel).
 *
 * Por paciente y por toma (primera y segunda toma de fotos):
 *  - procesa todas las réplicas .IS2 de la carpeta (segmentación, espejado,
 *    registro y grilla canónica — src/imaging/pointwise.js) y se queda con la
 *    de mejor calidad (solapamiento y simetría de las máscaras);
 *  - renderiza esa termografía con la paleta High Contrast (PNG sin
 *    metadatos, sólo la matriz IR);
 *  - guarda las grillas canónicas de cada pie (centésimas de °C).
 *
 * Los datos clínicos e identificatorios salen de la planilla más reciente
 * («Planillas clinicas (3).xlsx»). Todo queda en data-local/: NUNCA se debe
 * copiar a carpetas versionadas. El script no imprime nombres, DNI ni
 * teléfonos: sólo códigos y conteos.
 *
 * Uso: node scripts/precompute-real.js   (o npm run precompute:real)
 */
const fs = require('node:fs');
const path = require('node:path');
const { readXlsx, excelDate } = require('./lib/xlsx');
const { decodeIs2 } = require('../src/imaging/is2');
const { renderThermogram, displayRange } = require('../src/imaging/thermogram');
const { encodePng } = require('../src/imaging/png');
const { highContrast } = require('../src/utils/thermal');
const { analyzeIs2Pointwise, is2CaptureDate } = require('../src/imaging/pointwise');
const { marcaSinConsentimiento } = require('../src/utils/consent');
const { labelsToMasks } = require('../src/imaging/pointwise');
const { readNpy, is2Key } = require('./lib/npy');
const { decodeGrid } = require('../src/imaging/pointwise');
const { computeTci } = require('../src/imaging/tci');
const { serializeTci } = require('../src/services/predictors/pointwiseAnalysis');
const {
  REFERENCE_FILE,
  CRITERIO_COHORTE,
  selectReferenceMembers,
  loadReferenceStore,
  referenceFor,
} = require('../src/services/predictors/tciReference');

const ROOT = path.join(__dirname, '..');
const PRIVATE = path.join(ROOT, 'tesis-2026info');
const PLANILLA = path.join(PRIVATE, 'Planillas clinicas (3).xlsx');
const PRIMERA = path.join(PRIVATE, 'PRIMERAS FOTOS', 'PRIMERAS FOTOS');
const SEGUNDA = path.join(PRIVATE, 'SEGUNDA TOMA DE FOTOS');
const OUT = path.join(ROOT, 'data-local', 'real');
const IMG = path.join(OUT, 'img');
/** Máscaras de la U-Net (scripts/ml/segment_unet.py): una por archivo IS2, clave = hash de la ruta. */
const UNET_MASKS = path.join(ROOT, 'data-local', 'ml', 'unet-masks');
const USE_UNET = process.env.SEGMENTACION !== 'clasica';

/** Máscaras U-Net del archivo, si existen (si no, la segmentación clásica). */
function unetMasks(file) {
  if (!USE_UNET) return null;
  const f = path.join(UNET_MASKS, `${is2Key(PRIVATE, file)}.npy`);
  if (!fs.existsSync(f)) return null;
  try {
    return labelsToMasks(readNpy(f).data);
  } catch {
    return null;
  }
}

const CENTRO_POR_PREFIJO = { HC: 'Hospital Córdoba', VHF: 'Hospital Ferreyra', RF: 'Clínica Reina Fabiola' };
const CODE_RE = /^2?P\.?\s*(VHF|HC|RF)\.?\s*(\d{3})/i;

const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);

function parseCode(name) {
  const m = CODE_RE.exec(String(name).trim());
  return m ? `P.${m[1].toUpperCase()}${m[2]}` : null;
}

const siNo = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v >= 1;
  const s = String(v).trim().toUpperCase();
  if (['SI', 'SÍ', 'S', '1'].includes(s)) return true;
  if (['NO', 'N', '0'].includes(s)) return false;
  return null;
};
const numOr = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Grado de neuropatía de la planilla → puntaje aproximado (0–10) del portal. */
function neuroPuntaje(v) {
  if (typeof v === 'number') return v;
  const s = String(v || '')
    .trim()
    .toLowerCase();
  return { normal: 0, leve: 2, moderada: 4, grave: 7 }[s] ?? null;
}

function readClinical(sheets) {
  const datos = sheets.get('DATOS ') || sheets.get('DATOS');
  const out = new Map();
  for (const r of datos) {
    const codigo = parseCode(r[0]);
    if (!codigo || !/^P\./.test(String(r[0]).trim())) continue;
    const obs = r[1] ? String(r[1]).trim() : null;
    const grado = r[11];
    const neuro = siNo(r[10]);
    out.set(codigo, {
      // Todos los textos de la fila (para detectar la marca «sin consentimiento»).
      textos: r.filter((v) => typeof v === 'string'),
      observaciones: obs,
      noValido: obs ? /NO VALIDO/i.test(obs) : false,
      generoLesion: siNo(r[2]),
      edad: numOr(r[3]),
      sexo: typeof r[4] === 'string' ? r[4].trim().toUpperCase().slice(0, 1) : null,
      aniosEvolucionDm: numOr(r[5]),
      tipoDm: typeof r[6] === 'string' ? r[6].trim() : null,
      insulinorequiriente: siNo(r[7]),
      hba1c: numOr(r[8]),
      tabaquismo: siNo(r[9]),
      neuropatia: neuro,
      neuropatiaPuntaje: neuro ? neuroPuntaje(grado) : neuro === false ? 0 : null,
      vibratoriaDer: numOr(r[12]),
      vibratoriaIzq: numOr(r[13]),
      ulceraPreviaDer: siNo(r[14]),
      ulceraPreviaIzq: siNo(r[15]),
      isquemia: siNo(r[16]),
      ampollas: siNo(r[17]),
      hiperqueratosis: siNo(r[18]),
      eritema: siNo(r[19]),
      hematomas: siNo(r[20]),
    });
  }
  return out;
}

/** Hoja «Contactos»: bloques ID PACIENTE / Nombre y apellido / DNI / Contacto. */
function readContacts(sheets) {
  const rows = sheets.get('Contactos') || [];
  const out = new Map();
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c += 1) {
      if (typeof row[c] !== 'string' || !/^ID PACIENTE/i.test(row[c].trim())) continue;
      const codigo = parseCode(row[c + 1]);
      if (!codigo) continue;
      // El bloque del paciente termina en la próxima fila «ID PACIENTE» de la misma
      // columna (hay bloques compactos de dos filas): nunca se toman datos del siguiente.
      let alto = 1;
      while (alto < 4) {
        const v = (rows[r + alto] || [])[c];
        if (typeof v === 'string' && /^ID PACIENTE/i.test(v.trim())) break;
        alto += 1;
      }
      const cell = (dr) => (dr < alto ? (rows[r + dr] || [])[c + 1] : null);
      const nombre = typeof cell(1) === 'string' ? cell(1).trim() : null;
      const dni = cell(2) === null || cell(2) === undefined ? null : String(cell(2)).replace(/\D/g, '') || null;
      const tel = cell(3) === null || cell(3) === undefined ? null : String(cell(3)).trim() || null;
      const textos = [];
      for (let dr = 0; dr < alto; dr += 1) {
        for (let dc = 0; dc <= 2; dc += 1) {
          const v = (rows[r + dr] || [])[c + dc];
          if (typeof v === 'string') textos.push(v);
        }
      }
      out.set(codigo, { nombre, dni, telefono: tel, fechaToma1: excelDate(row[c + 2]), textos });
    }
  }
  return out;
}

/** Hoja «DifT°» (ROIs de la Parte 1, toma 1) para comparar con el método punto a punto. */
function readAna(sheets) {
  const rows = [...sheets.entries()].find(([n]) => /^DifT/i.test(n))?.[1] || [];
  const keys = ['dedo_mayor', 'dedos_menores', 'metatarso', 'arco_interno', 'arco_externo', 'talon'];
  const out = new Map();
  for (const r of rows) {
    const codigo = parseCode(r[0]);
    if (!codigo || !/^P\./.test(String(r[0]).trim())) continue;
    const rois = keys.map((roi, k) => ({ roi, avgDer: numOr(r[1 + k * 3]), avgIzq: numOr(r[2 + k * 3]) }));
    rois.push({ roi: 'general', avgDer: numOr(r[19]), avgIzq: numOr(r[20]) });
    out.set(codigo, {
      rois: rois.filter((x) => x.avgDer !== null && x.avgIzq !== null),
      simetrico: r[21] === 1 || r[21] === '1',
      grupo: typeof r[22] === 'string' ? r[22].trim().toUpperCase().slice(0, 1) : null,
    });
  }
  return out;
}

const listIs2 = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => /\.is2$/i.test(f))
        .sort()
        .map((f) => path.join(dir, f))
    : [];

function inventory(contacts) {
  const toma1 = new Map();
  for (const site of fs.readdirSync(PRIMERA)) {
    const siteDir = path.join(PRIMERA, site);
    if (!fs.statSync(siteDir).isDirectory()) continue;
    for (const d of fs.readdirSync(siteDir)) {
      const codigo = parseCode(d);
      if (codigo) toma1.set(codigo, listIs2(path.join(siteDir, d)));
    }
  }
  // Toma 2: por código en el nombre de la carpeta o, si no lo tiene, por nombre del paciente.
  const nameTokens = [...contacts.entries()].map(([codigo, c]) => ({ codigo, tokens: new Set(norm(c.nombre)) }));
  const toma2 = new Map();
  let porNombre = 0;
  let sinMatch = 0;
  for (const site of fs.readdirSync(SEGUNDA)) {
    const siteDir = path.join(SEGUNDA, site);
    if (!fs.statSync(siteDir).isDirectory()) continue;
    for (const d of fs.readdirSync(siteDir)) {
      const dir = path.join(siteDir, d);
      if (!fs.statSync(dir).isDirectory()) continue;
      let codigo = parseCode(d);
      if (!codigo) {
        const t = norm(d);
        const scored = nameTokens
          .map((p) => ({ codigo: p.codigo, n: t.filter((x) => p.tokens.has(x)).length }))
          .filter((s) => s.n > 0)
          .sort((a, b) => b.n - a.n);
        const ok =
          scored.length &&
          (scored[0].n >= 2 || (scored[0].n === 1 && t.length === 1 && scored.filter((s) => s.n === 1).length === 1)) &&
          (scored.length === 1 || scored[1].n < scored[0].n);
        if (ok) {
          codigo = scored[0].codigo;
          porNombre += 1;
        } else {
          sinMatch += 1;
          continue;
        }
      }
      const files = listIs2(dir);
      if (!files.length) continue;
      // Carpetas duplicadas de un mismo código: se juntan las réplicas.
      toma2.set(codigo, [...(toma2.get(codigo) || []), ...files]);
    }
  }
  return { toma1, toma2, porNombre, sinMatch };
}

function processToma(files, codigo, toma) {
  let best = null;
  let validas = 0;
  for (const file of files) {
    let buffer;
    try {
      buffer = fs.readFileSync(file);
      const masks = unetMasks(file);
      const r = analyzeIs2Pointwise(buffer, masks ? { masks, masksSource: 'unet' } : {});
      if (!r.ok) continue;
      validas += 1;
      if (!best || r.calidad > best.calidad) best = { ...r, file, fecha: is2CaptureDate(buffer) };
    } catch {
      // archivo ilegible: se ignora la réplica
    }
  }
  if (!best) return { toma, replicas: files.length, validas: 0, ok: false };
  const buffer = fs.readFileSync(best.file);
  const img = decodeIs2(buffer);
  const { lo, hi } = displayRange(buffer, img);
  const out = renderThermogram(img, { lo, hi, width: 640, height: 480, palette: highContrast });
  const imagen = `img/${codigo.replace('.', '')}-toma${toma}.png`;
  fs.writeFileSync(path.join(OUT, imagen), encodePng(out.width, out.height, out.rgb));
  return {
    toma,
    ok: true,
    fecha: best.fecha,
    replicas: files.length,
    validas,
    calidad: best.calidad,
    segmentacion: best.segmentacion,
    marco: best.marco,
    imagen,
    izq: best.izq,
    der: best.der,
  };
}

function main() {
  if (!fs.existsSync(PLANILLA) || !fs.existsSync(PRIMERA)) {
    console.error('Falta la carpeta privada tesis-2026info/ (planilla o primeras fotos). No se generó nada.');
    process.exit(1);
  }
  // Salida generada: se regenera completa (así no quedan imágenes de pacientes excluidos).
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(IMG, { recursive: true });
  const sheets = readXlsx(fs.readFileSync(PLANILLA));
  const clinical = readClinical(sheets);
  const contacts = readContacts(sheets);
  const ana = readAna(sheets);
  const inv = inventory(contacts);
  const codigos = [...new Set([...clinical.keys(), ...inv.toma1.keys()])].sort();

  const pacientes = [];
  let n = 0;
  let excluidos = 0;
  for (const codigo of codigos) {
    n += 1;
    // Pacientes que según la planilla NO dieron su consentimiento: se excluyen por
    // completo (sin ficha, sin tomas ni imágenes, sin entrenamiento).
    const textos = [...(contacts.get(codigo)?.textos || []), ...(clinical.get(codigo)?.textos || [])];
    if (textos.some(marcaSinConsentimiento)) {
      excluidos += 1;
      process.stdout.write(`[${n}/${codigos.length}] excluido (sin consentimiento)\n`);
      continue;
    }
    const prefijo = /^P\.([A-Z]+)/.exec(codigo)[1];
    const tomas = [];
    for (const [toma, files] of [
      [1, inv.toma1.get(codigo) || []],
      [2, inv.toma2.get(codigo) || []],
    ]) {
      if (files.length) tomas.push(processToma(files, codigo, toma));
    }
    const c = contacts.get(codigo) || {};
    pacientes.push({
      codigo,
      centro: CENTRO_POR_PREFIJO[prefijo] || 'Hospital Córdoba',
      identidad: { nombre: c.nombre || null, dni: c.dni || null, telefono: c.telefono || null },
      fechaToma1Planilla: c.fechaToma1 || null,
      clinica: clinical.get(codigo) ? { ...clinical.get(codigo), textos: undefined } : null,
      ana: ana.get(codigo) || null,
      tomas,
    });
    const t = tomas.map((x) => `t${x.toma}:${x.ok ? x.calidad : 'falla'}`).join(' ');
    process.stdout.write(`[${n}/${codigos.length}] ${codigo} ${t}\n`);
  }
  // Patrón de referencia del TCI: pacientes más simétricos de la cohorte (toma 1).
  const miembros = selectReferenceMembers(pacientes, CRITERIO_COHORTE);
  fs.writeFileSync(
    path.join(OUT, REFERENCE_FILE),
    JSON.stringify({
      _aviso: 'Grillas de pacientes reales. Local: no versionar.',
      fuente: 'cohorte',
      criterio: CRITERIO_COHORTE,
      miembros,
    }),
  );
  const store = loadReferenceStore(OUT);
  for (const p of pacientes) {
    // Leave-one-out: un miembro de la referencia nunca se compara consigo mismo.
    const ref = referenceFor(store, p.codigo);
    for (const t of p.tomas) {
      if (!t.ok) continue;
      t.tci = serializeTci(computeTci(decodeGrid(t.izq), decodeGrid(t.der), ref));
    }
  }
  console.log(`Referencia TCI: ${miembros.length} pacientes (criterio de simetría; LOO al puntuar a un miembro)`);
  const dataset = {
    _aviso: 'DATOS REALES DE PACIENTES. Local: no versionar, no publicar, no desplegar.',
    generado: new Date().toISOString(),
    planilla: path.basename(PLANILLA),
    pacientes,
  };
  fs.writeFileSync(path.join(OUT, 'dataset.json'), JSON.stringify(dataset));
  const conT1 = pacientes.filter((p) => p.tomas.some((t) => t.toma === 1 && t.ok)).length;
  const conT2 = pacientes.filter((p) => p.tomas.some((t) => t.toma === 2 && t.ok)).length;
  console.log(
    `\nPacientes: ${pacientes.length} (excluidos sin consentimiento: ${excluidos}) · con toma 1: ${conT1} · con toma 2: ${conT2} · ` +
      `carpetas de toma 2 asociadas por nombre: ${inv.porNombre} · sin asociar: ${inv.sinMatch}`,
  );
  console.log(`Salida: ${path.relative(ROOT, OUT)}/dataset.json`);
}

module.exports = { readClinical, readContacts, readAna, inventory, parseCode, PRIVATE, PLANILLA, PRIMERA, SEGUNDA };

if (require.main === module) main();
