#!/usr/bin/env node
'use strict';

/**
 * Exporta, para entrenar la U-Net de segmentación (scripts/ml/*.py), cada
 * réplica .IS2 de los pacientes con consentimiento como matrices .npy:
 *
 *   data-local/ml/cache/<clave>_t.npy    temperatura (°C aprox.), float32 240×320
 *   data-local/ml/cache/<clave>_cls.npy  segmentación clásica (0 fondo, 1 pie a
 *                                         la izquierda de la imagen, 2 a la derecha), uint8
 *   data-local/ml/cache/index.json       clave, código, toma, calidad, «no válido»
 *
 * La clave es un hash de la ruta del archivo (las carpetas de origen pueden
 * llevar nombres). Todo queda en data-local/ (ignorada por git y Vercel).
 * Se procesa un archivo por vez para no cargar todas las imágenes en memoria.
 *
 * Uso: node scripts/ml/export-seg-data.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { readXlsx } = require('../lib/xlsx');
const { writeNpy, is2Key } = require('../lib/npy');
const { decodeIs2 } = require('../../src/imaging/is2');
const { segmentFeetPointwise } = require('../../src/imaging/segmentation');
const { canonicalFeet, qualityScore, celsiusImage } = require('../../src/imaging/pointwise');
const { marcaSinConsentimiento } = require('../../src/utils/consent');
const pre = require('../precompute-real');

const OUT = path.join(__dirname, '..', '..', 'data-local', 'ml', 'cache');

function main() {
  if (!fs.existsSync(pre.PLANILLA)) {
    console.error('Falta la carpeta privada tesis-2026info/.');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const sheets = readXlsx(fs.readFileSync(pre.PLANILLA));
  const clinical = pre.readClinical(sheets);
  const contacts = pre.readContacts(sheets);
  const inv = pre.inventory(contacts);
  const index = [];
  let n = 0;
  for (const [toma, map] of [
    [1, inv.toma1],
    [2, inv.toma2],
  ]) {
    for (const [codigo, files] of map) {
      const textos = [...(contacts.get(codigo)?.textos || []), ...(clinical.get(codigo)?.textos || [])];
      if (textos.some(marcaSinConsentimiento)) continue;
      files.forEach((file, rep) => {
        n += 1;
        const key = is2Key(pre.PRIVATE, file);
        const entry = { key, codigo, toma, rep, noValido: Boolean(clinical.get(codigo)?.noValido), ok: false };
        try {
          const img = decodeIs2(fs.readFileSync(file));
          const T = celsiusImage(img);
          const seg = segmentFeetPointwise(T, img);
          const cls = new Uint8Array(T.length);
          if (seg.ok) {
            seg.feet.forEach((f, k) => {
              for (let i = 0; i < cls.length; i += 1) if (f.mask[i]) cls[i] = k + 1;
            });
            const cf = canonicalFeet(img);
            entry.ok = cf.ok;
            entry.calidad = cf.ok ? qualityScore(cf) : null;
            entry.marco = cf.ok ? cf.marco : null;
          }
          writeNpy(path.join(OUT, `${key}_t.npy`), T, [img.height, img.width]);
          writeNpy(path.join(OUT, `${key}_cls.npy`), cls, [img.height, img.width]);
          entry.exportado = true;
        } catch {
          entry.exportado = false;
        }
        index.push(entry);
        if (n % 50 === 0) process.stdout.write(`${n} archivos\n`);
      });
    }
  }
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
  const ok = index.filter((e) => e.ok).length;
  console.log(
    `Exportados: ${index.filter((e) => e.exportado).length} de ${index.length} (segmentación clásica ok: ${ok}).`,
  );
}

main();
