#!/usr/bin/env node
'use strict';

/**
 * Precalcula el análisis punto a punto de TODOS los pacientes reales a partir
 * de la carpeta privada `tesis-2026info/` (no versionada) y deja el resultado
 * en `data-local/real/` (también ignorada por git y por Vercel).
 *
 * Por paciente y por toma (primera y segunda toma de fotos):
 *  - procesa todas las réplicas .IS2 de la carpeta (segmentación, espejado,
 *    registro y grilla canónica — src/imaging/pointwise.js) y sugiere UNA
 *    (src/imaging/replicaChoice.js): la mejor sin banderas graves;
 *  - renderiza cada réplica con la paleta High Contrast (PNG sin metadatos,
 *    sólo la matriz IR);
 *  - guarda las grillas canónicas de cada pie (centésimas de °C) y el TCI de
 *    cada réplica (`porReplica`), para poder cambiar la foto de la toma sin
 *    volver a procesar los IS2.
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
const { localDataPath } = require('../src/config/localData');
const { decodeIs2, decodeVisible } = require('../src/imaging/is2');
const { renderThermogram, displayRange } = require('../src/imaging/thermogram');
const { encodePng } = require('../src/imaging/png');
const { highContrast } = require('../src/utils/thermal');
const { is2CaptureDate, canonicalFeet, qualityScore, encodeGrid } = require('../src/imaging/pointwise');
const { marcaSinConsentimiento } = require('../src/utils/consent');
const { labelsToMasks } = require('../src/imaging/pointwise');
const { readNpy, writeNpy, is2Key } = require('./lib/npy');
const { decodeGrid } = require('../src/imaging/pointwise');
const Q = require('../src/imaging/photoQuality');
const { alignVisible, reconcileShifts, visibleSharpness } = require('../src/imaging/visibleAlign');
const { computeTci } = require('../src/imaging/tci');
const { serializeTci } = require('../src/services/predictors/pointwiseAnalysis');
const { sugerirReplica } = require('../src/imaging/replicaChoice');
const { encodeRle } = require('../src/services/MaskService');

/** Par de máscaras → etiquetas (0 fondo, 1 pie a la izquierda de la imagen, 2 a la derecha). */
function etiquetas(mascaras) {
  const lab = new Uint8Array(320 * 240);
  for (let i = 0; i < lab.length; i += 1) lab[i] = mascaras[0][i] ? 1 : mascaras[1][i] ? 2 : 0;
  return lab;
}
const { exclusionTesis } = require('../src/utils/tesisExclusion');
const {
  REFERENCE_FILE,
  CRITERIO_COHORTE,
  selectReferenceMembers,
  publicControlMembers,
  loadReferenceStore,
  referenceFor,
} = require('../src/services/predictors/tciReference');

const ROOT = path.join(__dirname, '..');
const PRIVATE = process.env.PRIVATE_DATA_DIR || path.join(ROOT, 'tesis-2026info');
const PLANILLA = path.join(PRIVATE, 'Planillas clinicas (3).xlsx');
const PRIMERA = path.join(PRIVATE, 'PRIMERAS FOTOS', 'PRIMERAS FOTOS');
const SEGUNDA = path.join(PRIVATE, 'SEGUNDA TOMA DE FOTOS');
// REAL_DATA_DIR / LOCAL_DATA_DIR permiten generar otra versión (p. ej. data-local/real-v2) sin pisar la que usa el portal.
const OUT = process.env.REAL_DATA_DIR || localDataPath('real');
const IMG = path.join(OUT, 'img');
/** Máscaras de la U-Net (scripts/ml/segment_unet.py): una por archivo IS2, clave = hash de la ruta. */
const UNET_MASKS = localDataPath('ml', 'unet-masks');
const USE_UNET = process.env.SEGMENTACION !== 'clasica';
/**
 * Corrección de fotos (por defecto activa; CORRECCION_FOTOS=0 vuelve al
 * criterio anterior: sólo la calidad de registro, sin limpieza de máscaras):
 *  - limpieza de las máscaras por forma (src/imaging/maskCleanup.js);
 *  - banderas de calidad por réplica y elección por puntaje
 *    (src/imaging/photoQuality.js);
 *  - alineación de la foto visible por réplica (src/imaging/visibleAlign.js).
 * Nunca se modifican temperaturas.
 */
const CORRECCION = process.env.CORRECCION_FOTOS !== '0';
/** Réplicas a menos de esta diferencia de puntaje se consideran equivalentes (gana la primera captura). */
const EMPATE =
  Number.isFinite(Number(process.env.SELECCION_EMPATE)) && process.env.SELECCION_EMPATE !== undefined
    ? Number(process.env.SELECCION_EMPATE)
    : Q.EMPATE;
/** Calidad automática por réplica (clave → banderas, alineación, encuadre). */
const FOTOS_FILE = 'fotos.json';
const fotos = { replicas: {}, tomas: {} };
const errores = [];
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

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
      // Motivo de la exclusión en la Parte 1 de la tesis ('imagen' | 'peso'), sólo como dato histórico.
      exclusionTesis: exclusionTesis(obs),
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

/**
 * Calidad automática de una réplica ya segmentada: medidas, banderas,
 * alineación de la foto visible y sugerencias de vista (encuadre, giro).
 */
function evaluarReplica(buffer, cf) {
  const w = 320;
  const h = 240;
  const metricas = Q.replicaMetrics({ T: cf.temperatura, masks: cf.mascaras, width: w, height: h });
  const fg = new Uint8Array(w * h);
  for (let i = 0; i < fg.length; i += 1) fg[i] = cf.mascaras[0][i] || cf.mascaras[1][i] ? 1 : 0;
  let alineacion = null;
  let nitidezFoto = null;
  const vis = decodeVisible(buffer);
  if (vis) {
    const { gray, ...al } = alignVisible(vis, fg);
    alineacion = al;
    nitidezFoto = visibleSharpness(gray, vis.width, vis.height, fg, al);
  }
  return { metricas, alineacion, nitidezFoto, vista: Q.displayHints(metricas) };
}

function processToma(files, codigo, toma) {
  const cands = [];
  for (const [rep, file] of files.entries()) {
    try {
      const buffer = fs.readFileSync(file);
      const masks = unetMasks(file);
      const cf = canonicalFeet(decodeIs2(buffer), {
        ...(masks ? { masks, masksSource: 'unet' } : {}),
        limpiar: CORRECCION,
        conMascaras: CORRECCION,
      });
      if (!cf.ok) continue;
      const calidad = qualityScore(cf);
      const c = { rep, file, key: is2Key(PRIVATE, file), cf, calidad, fecha: is2CaptureDate(buffer), puntaje: calidad };
      if (CORRECCION) Object.assign(c, evaluarReplica(buffer, cf));
      cands.push(c);
    } catch (err) {
      // archivo ilegible: se ignora la réplica (sólo se cuenta; sin rutas ni nombres)
      errores.push(err && err.message ? err.message.slice(0, 80) : String(err));
    }
  }
  if (CORRECCION) {
    // Un desplazamiento grande de la foto sólo se aplica si otra réplica lo respalda.
    reconcileShifts(cands.map((c) => c.alineacion));
    for (const c of cands) {
      c.banderas = Q.qualityFlags({ ...c.metricas, nitidezFoto: c.nitidezFoto, alineacion: c.alineacion });
      c.puntaje = Q.selectionScore(c.calidad, c.banderas, c.metricas);
    }
  }
  const validas = cands.length;
  // Una sola foto por toma (src/imaging/replicaChoice.js): la sugerida es la mejor
  // entre las réplicas sin banderas graves (o la menos afectada si ninguna pasa).
  // Sin corrección: la de mayor calidad (la primera si empatan), como antes.
  const best = CORRECCION
    ? sugerirReplica(cands, { empate: EMPATE })
    : cands.reduce((a, b) => (!a || b.calidad > a.calidad ? b : a), null);
  if (!best) return { toma, replicas: files.length, validas: 0, ok: false };
  let calidadFotos = null;
  if (CORRECCION) {
    const tq = Q.tomaQuality(cands, best);
    calidadFotos = { ...tq, rep: best.rep + 1, sugerida: best.rep + 1, elegidaPor: null };
    (fotos.tomas[codigo] ||= {})[toma] = { elegida: best.key, ...calidadFotos };
    for (const c of cands) {
      const m = c.metricas;
      fotos.replicas[c.key] = {
        codigo,
        toma,
        rep: c.rep,
        calidad: c.calidad,
        puntaje: c.puntaje,
        elegida: c === best,
        banderas: c.banderas,
        segmentacion: c.cf.segmentacion,
        limpieza: c.cf.limpieza,
        metricas: {
          largoMin: r3(m.largoMin),
          largoAnchoMin: r3(m.largoAnchoMin),
          largoAnchoMax: r3(m.largoAnchoMax),
          areaRatio: r3(m.areaRatio),
          margen: m.margen,
          separacion: r3(m.separacion),
          puente: m.puente,
          anguloMax: r3(m.anguloMax),
          anguloDif: r3(m.anguloDif),
          contraste: r3(m.contraste),
          fondoC: r3(m.fondoC),
          nitidezIr: r3(m.nitidezIr),
          nitidezFoto: r3(c.nitidezFoto),
        },
        alineacion: c.alineacion,
        encuadre: c.vista.encuadre,
        giro: c.vista.giro,
      };
      // Máscara limpia (0 fondo, 1 pie a la izquierda de la imagen, 2 a la derecha) si cambió.
      if (c.cf.limpieza?.cambiados) {
        writeNpy(path.join(OUT, 'mascaras', `${c.key}.npy`), etiquetas(c.cf.mascaras), [240, 320]);
      }
    }
  }
  // Grillas, calidad e imagen de CADA réplica: elegir otra foto en «Revisión de
  // fotos» vuelve a analizar la toma sin reprocesar los IS2.
  const porReplica = [...cands]
    .sort((a, b) => a.rep - b.rep)
    .map((c) => {
      const buffer = fs.readFileSync(c.file);
      const img = decodeIs2(buffer);
      const { lo, hi } = displayRange(buffer, img);
      const out = renderThermogram(img, { lo, hi, width: 640, height: 480, palette: highContrast });
      const imagen = `img/${codigo.replace('.', '')}-toma${toma}-r${c.rep + 1}.png`;
      fs.writeFileSync(path.join(OUT, imagen), encodePng(out.width, out.height, out.rgb));
      return {
        rep: c.rep + 1,
        clave: c.key,
        calidad: c.calidad,
        puntaje: r3(c.puntaje),
        banderas: c.banderas || [],
        segmentacion: c.cf.segmentacion,
        marco: c.cf.marco,
        fecha: c.fecha,
        imagen,
        izq: encodeGrid(c.cf.izq),
        der: encodeGrid(c.cf.der),
        // Contorno usado (U-Net limpia o clásica) en RLE: punto de partida de «Corregir contorno».
        mascara: c.cf.mascaras ? encodeRle(etiquetas(c.cf.mascaras)) : null,
      };
    });
  const elegida = porReplica.find((r) => r.rep === best.rep + 1);
  return {
    toma,
    ok: true,
    fecha: best.fecha,
    replicas: files.length,
    validas,
    calidad: best.calidad,
    // Réplica sugerida: número (1 = primera captura) y clave no identificatoria (hash de la ruta).
    replica: best.rep + 1,
    clave: best.key,
    segmentacion: best.cf.segmentacion,
    marco: best.cf.marco,
    imagen: elegida.imagen,
    izq: elegida.izq,
    der: elegida.der,
    ...(calidadFotos ? { calidadFotos } : {}),
    porReplica,
  };
}

function main() {
  if (process.env.LOCAL_DATA_DIR && !process.env.REAL_DATA_DIR) {
    // Salvaguarda: con otra carpeta local, la salida debe ser explícita (se regenera completa).
    console.error('Con LOCAL_DATA_DIR hay que definir también REAL_DATA_DIR (carpeta de salida).');
    process.exit(1);
  }
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
  // Patrón de referencia del TCI: grupo control de la base pública 2019 si está
  // en local (TCI_REFERENCIA=cohorte fuerza la alternativa); si no, los
  // pacientes más simétricos de la cohorte (toma 1).
  const publicos = process.env.TCI_REFERENCIA === 'cohorte' ? [] : publicControlMembers();
  const fuente = publicos.length ? 'hernandez2019' : 'cohorte';
  const miembros = publicos.length ? publicos : selectReferenceMembers(pacientes, CRITERIO_COHORTE);
  fs.writeFileSync(
    path.join(OUT, REFERENCE_FILE),
    JSON.stringify({
      _aviso: 'Grillas de referencia (pacientes reales o base pública). Local: no versionar.',
      fuente,
      criterio: fuente === 'cohorte' ? CRITERIO_COHORTE : 'Grupo control de la base pública (todos los sujetos)',
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
      for (const r of t.porReplica || []) {
        r.tci = r.rep === t.replica ? t.tci : serializeTci(computeTci(decodeGrid(r.izq), decodeGrid(r.der), ref));
      }
    }
  }
  if (errores.length)
    console.log(`Réplicas con error: ${errores.length} (${[...new Set(errores)].slice(0, 3).join(' | ')})`);
  console.log(`Referencia TCI (${fuente}): ${miembros.length} miembros`);
  const dataset = {
    _aviso: 'DATOS REALES DE PACIENTES. Local: no versionar, no publicar, no desplegar.',
    generado: new Date().toISOString(),
    planilla: path.basename(PLANILLA),
    pacientes,
  };
  fs.writeFileSync(path.join(OUT, 'dataset.json'), JSON.stringify(dataset));
  if (CORRECCION) {
    fs.writeFileSync(
      path.join(OUT, FOTOS_FILE),
      JSON.stringify({
        _aviso: 'Calidad automática por réplica (claves = hash de la ruta). Local: no versionar.',
        version: 1,
        generado: dataset.generado,
        umbrales: Q.UMBRALES,
        ...fotos,
      }),
    );
    const reps = Object.values(fotos.replicas);
    const tomasQ = Object.values(fotos.tomas).flatMap((t) => Object.values(t));
    console.log(
      `Fotos: ${reps.length} réplicas · máscaras limpiadas ${reps.filter((r) => r.limpieza?.cambiados).length} · ` +
        `fotos realineadas ${reps.filter((r) => r.alineacion?.aplicada).length} · ` +
        `tomas con calidad baja ${tomasQ.filter((t) => t.baja).length} de ${tomasQ.length}`,
    );
  }
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
