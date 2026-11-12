#!/usr/bin/env node
'use strict';

/**
 * Genera las imágenes demo a partir de termogramas REALES (.IS2 de Fluke) de
 * la carpeta privada `tesis-2026info/` (no versionada), con autorización del
 * equipo del proyecto.
 *
 * El mapeo par → archivos de origen está en `scripts/demo-pairs.local.json`
 * (local, gitignoreado). Para cada termograma:
 *  - decodifica SÓLO la matriz infrarroja (Images/Main/IR.data); nunca se
 *    publican las fotos visibles ni las miniaturas (tienen fecha y hora);
 *  - calcula la escala como la cámara (24–35 °C) calibrándola contra la
 *    miniatura del propio IS2 (sólo en memoria);
 *  - renderiza con la paleta High Contrast de Fluke (predeterminada) y las
 *    variantes Ironbow y escala de grises, 800×600, interpolación bicúbica,
 *    PNG sin metadatos;
 *  - estima las temperaturas por ROI y las guarda en src/seed/demoImages.json.
 *
 * Uso: npm run generate:images
 */
const fs = require('node:fs');
const path = require('node:path');
const { decodeIs2 } = require('../src/imaging/is2');
const { analyzeThermogram, renderThermogram, roisInCelsius, displayRange } = require('../src/imaging/thermogram');
const { encodePng } = require('../src/imaging/png');
const { PALETTES, DEFAULT_PALETTE } = require('../src/utils/thermal');

const ROOT = path.join(__dirname, '..');
const PRIVATE = path.join(ROOT, 'tesis-2026info');
const OUT = path.join(ROOT, 'public', 'demo');
const SEED_OUT = path.join(ROOT, 'src', 'seed', 'demoImages.json');
const LOCAL = path.join(__dirname, 'demo-pairs.local.json');
const SEGUNDA = path.join(PRIVATE, 'SEGUNDA TOMA DE FOTOS');

/** La carpeta de toma 2 se busca por prefijo de código (el resto del nombre no se usa). */
function resolveToma2(rel) {
  const [folderCode, file] = rel.split('/');
  for (const site of fs.readdirSync(SEGUNDA)) {
    const match = fs.readdirSync(path.join(SEGUNDA, site)).find((d) => d.startsWith(folderCode));
    if (match) return path.join(SEGUNDA, site, match, file);
  }
  throw new Error(`No se encontró la carpeta de toma 2 del par (${folderCode.length} caracteres)`);
}

function main() {
  if (!fs.existsSync(PRIVATE) || !fs.existsSync(LOCAL)) {
    console.error(
      'Faltan tesis-2026info/ o scripts/demo-pairs.local.json: las imágenes demo ya están en public/demo/.',
    );
    process.exit(1);
  }
  const { pares } = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT).filter((x) => /^par-\d+-toma\d/.test(x))) fs.unlinkSync(path.join(OUT, f));

  const manifest = [];
  for (const par of pares) {
    const n = String(par.par).padStart(2, '0');
    const buffers = [fs.readFileSync(path.join(PRIVATE, par.toma1)), fs.readFileSync(resolveToma2(par.toma2))];
    const entry = { par: par.par };
    buffers.forEach((buffer, i) => {
      const toma = i + 1;
      const img = decodeIs2(buffer);
      const { lo, hi, calibrado } = displayRange(buffer, img);
      const file = `par-${n}-toma${toma}.png`;
      for (const pal of Object.values(PALETTES)) {
        const name = pal.key === DEFAULT_PALETTE ? file : file.replace('.png', `-${pal.key}.png`);
        const { width, height, rgb } = renderThermogram(img, { lo, hi, width: 800, height: 600, palette: pal.fn });
        fs.writeFileSync(path.join(OUT, name), encodePng(width, height, rgb));
      }
      const analysis = analyzeThermogram(img);
      if (!analysis.ok) throw new Error(`Par ${n} toma ${toma}: ${analysis.reason}`);
      entry[`toma${toma}`] = { file, rois: roisInCelsius(analysis) };
      console.log(
        `par ${n} toma ${toma}: ${file} (escala ${calibrado ? 'calibrada con la cámara' : 'por percentiles'})`,
      );
    });
    manifest.push(entry);
  }
  fs.writeFileSync(
    SEED_OUT,
    `${JSON.stringify({ _descripcion: 'Generado por scripts/generate-demo-images.js. Temperaturas por ROI estimadas (°C aprox.).', pares: manifest }, null, 2)}\n`,
  );
  console.log(`Manifiesto: ${path.relative(ROOT, SEED_OUT)}`);
}

main();
