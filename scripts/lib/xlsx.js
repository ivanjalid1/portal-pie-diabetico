'use strict';

/**
 * Lector mínimo de planillas .xlsx (sin dependencias): un .xlsx es un ZIP con
 * XML. Devuelve, por hoja, una matriz de valores (texto o número) leída de
 * `xl/sharedStrings.xml` y `xl/worksheets/sheetN.xml`. Alcanza para las
 * planillas clínicas del equipo (sin fórmulas que haya que evaluar: se usa el
 * valor cacheado que guarda Excel).
 */
const { readZip } = require('../../src/imaging/zip');

const decodeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

function textOf(xml) {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) out += decodeXml(m[1]);
  return out;
}

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** @returns {Map<string, Array<Array<string|number|null>>>} nombre de hoja → filas */
function readXlsx(buffer) {
  const zip = readZip(buffer);
  const get = (name) => (zip.has(name) ? zip.get(name)().toString('utf8') : null);
  const shared = [];
  const ss = get('xl/sharedStrings.xml');
  if (ss) {
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(ss))) shared.push(textOf(m[1]));
  }
  const wb = get('xl/workbook.xml');
  const rels = get('xl/_rels/workbook.xml.rels') || '';
  const target = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const t = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && t) target[id] = t.replace(/^\/?xl\//, '');
  }
  const sheets = new Map();
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeXml(/name="([^"]*)"/.exec(m[0])[1]);
    const rid = /r:id="([^"]+)"/.exec(m[0])[1];
    const xml = get(`xl/${target[rid]}`);
    const rows = [];
    if (xml) {
      for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const r = Number(/\br="(\d+)"/.exec(rm[0])?.[1]) - 1;
        const row = [];
        for (const cm of (rm[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = cm[1];
          const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
          if (!ref) continue;
          const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
          const inner = cm[2] || '';
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
          let value = null;
          if (type === 's' && v !== undefined) value = shared[Number(v)] ?? null;
          else if (type === 'inlineStr') value = textOf(inner);
          else if (type === 'str' || type === 'e') value = v === undefined ? null : decodeXml(v);
          else if (type === 'b') value = v === '1';
          else if (v !== undefined) value = Number(v);
          row[colIndex(ref)] = value;
        }
        rows[r] = row;
      }
    }
    for (let i = 0; i < rows.length; i += 1) if (!rows[i]) rows[i] = [];
    sheets.set(name, rows);
  }
  return sheets;
}

/** Número de serie de Excel (días desde 1899-12-30) → ISO (AAAA-MM-DD). */
function excelDate(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
}

module.exports = { readXlsx, excelDate };
