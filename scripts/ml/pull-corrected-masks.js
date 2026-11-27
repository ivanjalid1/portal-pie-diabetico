#!/usr/bin/env node
'use strict';

/**
 * Descarga de producción (Supabase) todos los contornos corregidos a mano en
 * «Revisión de fotos» (tabla study_mask_corrections + bucket privado
 * `estudios`) y los deja como etiquetas verdaderas para reentrenar y evaluar
 * la U-Net:
 *
 *   data-local/ml/corrected-masks/<clave>.npy   uint8 240 × 320 (0 fondo, 1 pie a la izquierda de la imagen, 2 a la derecha)
 *   data-local/ml/corrected-masks/<clave>.json  metadatos (fecha, origen «portal», píxeles por pie)
 *
 * La clave es el hash de la ruta del IS2 (la misma de data-local/ml/cache), así
 * que scripts/ml/train_unet.py y scripts/ml/dice_corrected.py los usan
 * directamente. Nada pasa por git: data-local/ está ignorada. No imprime
 * datos personales: sólo conteos.
 *
 * Después: python scripts/ml/dice_corrected.py (Dice de la U-Net vs los manuales) y, para
 * reentrenar con ellos, python scripts/ml/train_unet.py.
 *
 * Uso: node scripts/ml/pull-corrected-masks.js [--dry-run]
 */
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { buildConfig } = require('../../src/config');
  const { createDataLayer } = require('../../src/repositories/RepositoryFactory');
  const { decodeRle } = require('../../src/services/MaskService');
  const { writeNpy } = require('../lib/npy');

  const config = buildConfig({ ...process.env, DATA_DRIVER: 'supabase' });
  const { repos } = createDataLayer(config);
  const out = path.join(config.localDataDir, 'ml', 'corrected-masks');
  const rows = await repos.maskCorrections.listAll();
  const tot = { filas: rows.length, guardadas: 0, sinClave: 0, sinArchivo: 0 };
  if (!dryRun) fs.mkdirSync(out, { recursive: true });
  for (const r of rows) {
    if (!/^[0-9a-f]{16}$/.test(String(r.clave))) {
      tot.sinClave += 1;
      continue;
    }
    const gz = r.storagePath ? await repos.files.read(r.storagePath) : null;
    if (!gz) {
      tot.sinArchivo += 1;
      continue;
    }
    const f = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
    const labels = decodeRle(f.rle);
    if (!dryRun) {
      writeNpy(path.join(out, `${r.clave}.npy`), labels, [240, 320]);
      fs.writeFileSync(
        path.join(out, `${r.clave}.json`),
        JSON.stringify(
          {
            key: r.clave,
            fecha: r.corregidoAt,
            origen: 'portal',
            partiDe: f.origen || null,
            pixeles: r.pixeles || null,
          },
          null,
          2,
        ),
      );
    }
    tot.guardadas += 1;
  }
  console.log(
    `${dryRun ? '[dry-run] ' : ''}contornos corregidos: ${JSON.stringify(tot)} → ${path.relative(process.cwd(), out)}`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error al descargar los contornos corregidos:', err.message);
    process.exit(1);
  });
}
