#!/usr/bin/env node
'use strict';

/**
 * Precalcula el análisis punto a punto de los 10 pares DEMO (los mismos
 * termogramas anonimizados de public/demo) y lo guarda en
 * src/seed/demoPointwise.json. Contiene sólo grillas de temperatura de la
 * planta (centésimas de °C), calidad y geometría: ningún dato identificatorio.
 *
 * Requiere la carpeta privada tesis-2026info/ y scripts/demo-pairs.local.json
 * (ambos locales). Uso: node scripts/generate-demo-pointwise.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { analyzeIs2Pointwise } = require('../src/imaging/pointwise');

const ROOT = path.join(__dirname, '..');
const PRIVATE = path.join(ROOT, 'tesis-2026info');
const LOCAL = path.join(__dirname, 'demo-pairs.local.json');
const SEGUNDA = path.join(PRIVATE, 'SEGUNDA TOMA DE FOTOS');
const OUT = path.join(ROOT, 'src', 'seed', 'demoPointwise.json');

function resolveToma2(rel) {
  const [folderCode, file] = rel.split('/');
  for (const site of fs.readdirSync(SEGUNDA)) {
    const match = fs.readdirSync(path.join(SEGUNDA, site)).find((d) => d.startsWith(folderCode));
    if (match) return path.join(SEGUNDA, site, match, file);
  }
  throw new Error('No se encontró la carpeta de toma 2 de un par demo');
}

function main() {
  if (!fs.existsSync(PRIVATE) || !fs.existsSync(LOCAL)) {
    console.error(
      'Faltan tesis-2026info/ o scripts/demo-pairs.local.json: src/seed/demoPointwise.json ya está generado.',
    );
    process.exit(1);
  }
  const { pares } = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
  const out = [];
  for (const par of pares) {
    const entry = { par: par.par };
    const files = { toma1: path.join(PRIVATE, par.toma1), toma2: resolveToma2(par.toma2) };
    for (const [slot, file] of Object.entries(files)) {
      const r = analyzeIs2Pointwise(fs.readFileSync(file));
      if (!r.ok) throw new Error(`Par ${par.par} ${slot}: ${r.reason}`);
      entry[slot] = { calidad: r.calidad, marco: r.marco, izq: r.izq, der: r.der };
    }
    out.push(entry);
    console.log(`par ${par.par}: calidad ${entry.toma1.calidad} / ${entry.toma2.calidad}`);
  }
  fs.writeFileSync(
    OUT,
    `${JSON.stringify({ _descripcion: 'Generado por scripts/generate-demo-pointwise.js. Grillas canónicas (centésimas de °C, base64 Int16) de los pares demo anonimizados.', pares: out })}\n`,
  );
  console.log(`Salida: ${path.relative(ROOT, OUT)}`);
}

main();
