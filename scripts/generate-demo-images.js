#!/usr/bin/env node
'use strict';

/**
 * Genera las imágenes demo a partir de termogramas REALES (.IS2 de Fluke)
 * de la carpeta privada `tesis-2026info/` (no versionada), con autorización
 * del equipo del proyecto.
 *
 * Para cada par toma 1 / toma 2 (ver scripts/demo-pairs.json):
 *  - decodifica SÓLO la matriz infrarroja (Images/Main/IR.data); nunca se
 *    leen las fotos visibles ni las miniaturas con texto;
 *  - normaliza con percentiles comunes a ambas tomas (para que sean
 *    comparables), aplica la paleta ironbow, amplía con interpolación
 *    bicúbica a 960×720 y agrega una barra de color sin texto;
 *  - escribe PNG sin metadatos (sin EXIF, número de serie ni fecha);
 *  - estima las temperaturas por ROI (segmentación simple + conversión
 *    aproximada cuentas→°C) y las guarda en src/seed/demoImages.json para que
 *    los valores de la demo sean coherentes con lo que muestra cada imagen.
 *
 * Uso: npm run generate:images
 */
const fs = require('node:fs');
const path = require('node:path');
const { decodeIs2, percentile } = require('../src/imaging/is2');
const { analyzeThermogram, renderThermogram, roisInCelsius } = require('../src/imaging/thermogram');
const { encodePng } = require('../src/imaging/png');

const ROOT = path.join(__dirname, '..');
const PRIVATE = path.join(ROOT, 'tesis-2026info');
const OUT = path.join(ROOT, 'public', 'demo');
const SEED_OUT = path.join(ROOT, 'src', 'seed', 'demoImages.json');
const { pares } = require('./demo-pairs.json');

const SEGUNDA = path.join(PRIVATE, 'SEGUNDA TOMA DE FOTOS');

/** La carpeta de toma 2 se busca por prefijo de código (el resto del nombre no se usa). */
function resolveToma2(rel) {
  const [folderCode, file] = rel.split('/');
  for (const site of fs.readdirSync(SEGUNDA)) {
    const match = fs.readdirSync(path.join(SEGUNDA, site)).find((d) => d.startsWith(folderCode));
    if (match) return path.join(SEGUNDA, site, match, file);
  }
  throw new Error(`No se encontró la carpeta de toma 2 para ${folderCode}`);
}

function main() {
  if (!fs.existsSync(PRIVATE)) {
    console.error('No existe tesis-2026info/: las imágenes demo ya generadas están en public/demo/.');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const manifest = [];
  for (const par of pares) {
    const n = String(par.par).padStart(2, '0');
    const imgs = [
      decodeIs2(fs.readFileSync(path.join(PRIVATE, par.toma1))),
      decodeIs2(fs.readFileSync(resolveToma2(par.toma2))),
    ];
    // Escala común a ambas tomas del par.
    const lo = Math.min(...imgs.map((im) => percentile(im.data, 2)));
    const hi = Math.max(...imgs.map((im) => percentile(im.data, 99.7)));
    const entry = { par: par.par };
    imgs.forEach((img, i) => {
      const toma = i + 1;
      const file = `par-${n}-toma${toma}.png`;
      const { width, height, rgb } = renderThermogram(img, { lo, hi, width: 960, height: 720 });
      fs.writeFileSync(path.join(OUT, file), encodePng(width, height, rgb));
      const analysis = analyzeThermogram(img);
      if (!analysis.ok) throw new Error(`Par ${n} toma ${toma}: ${analysis.reason}`);
      entry[`toma${toma}`] = { file, rois: roisInCelsius(analysis) };
      console.log(`par ${n} toma ${toma}: ${file}`);
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
