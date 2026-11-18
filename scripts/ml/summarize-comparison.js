#!/usr/bin/env node
'use strict';

/**
 * Agrega a src/config/models/model-comparison.json (sólo métricas agregadas,
 * se muestra en «Detalle técnico») los resultados de:
 *  - scripts/ml/train_adjusted.py: HbA1c > 7 % con features invariantes y ajuste por centro;
 *  - scripts/ml/train_public.py: diabetes vs control en la base pública 2019.
 * Uso: node scripts/ml/summarize-comparison.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ML = path.join(ROOT, 'data-local', 'ml');
const DEST = path.join(ROOT, 'src', 'config', 'models', 'model-comparison.json');

const NOMBRES_AJ = {
  control_centro: 'Control: sólo el centro de atención',
  contralateral: 'Contralateral: área, |ΔT| medio y p95, diferencia de nivel, asimetría de patrón',
  contralateral_mas_centro: 'Contralateral + centro',
  normalizado: 'Normalizado por sujeto (T − mediana del pie, por angiosoma y zona)',
  normalizado_mas_centro: 'Normalizado + centro',
  normalizado_z: 'Normalizado z (÷ rango intercuartil)',
  normalizado_z_mas_centro: 'Normalizado z + centro',
  invariante: 'Todas las invariantes',
  invariante_mas_centro: 'Todas las invariantes + centro',
  tci_patron_directo: 'TCI de patrón (referencia: controles públicos), directo',
  tci_absoluto_directo: 'TCI absoluto (referencia: controles públicos), directo',
  patron_diabetico_directo: 'Puntaje del modelo de patrón diabético, directo',
};
const NOMBRES_PUB = {
  patron_lr: 'Logística sobre features invariantes (la del portal)',
  cnn_rel: 'CNN chica sobre mapas relativos',
  nivel: 'Temperatura absoluta del pie (no trasladable)',
  patron_mas_nivel_lr: 'Invariantes + temperatura absoluta (no trasladable)',
  tci_base: 'TCI publicado en la base',
  tci_clase: 'Clase de TCI publicada (1–5)',
  control_edad: 'Control: edad sola',
  patron_mas_edad_lr: 'Invariantes + edad',
};

const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

function main() {
  const doc = read(DEST);
  const aj = read(path.join(ML, 'adjusted-comparison-hba1c7.json'));
  const pub = read(path.join(ML, 'public-model-comparison.json'));
  if (aj) {
    doc.ajustado = {
      desenlace: 'HbA1c > 7 % (sustituto)',
      metodo:
        'Features invariantes a la adquisición; 5 pliegues estratificados por desenlace × centro × 20 repeticiones, C anidado. «Dentro de centro»: AUC calculada dentro de cada centro con ≥ 3 casos por clase y ponderada por n (no mezcla centros).',
      n: aj.n,
      positivos: aj.positivos,
      modelos: aj.modelos
        .filter((m) => NOMBRES_AJ[m.modelo])
        .map((m) => ({
          modelo: m.modelo,
          nombre: NOMBRES_AJ[m.modelo],
          auc: r3(m.aucMedia),
          aucIC95: m.aucIC95,
          aucDentroDeCentro: r3(m.aucDentroPonderada),
          pPermutacionDentroDeCentro: m.pPermutacionDentroDeCentro ?? null,
        })),
      conclusion:
        'Con features invariantes, la mejor variante (todas las invariantes) llega a AUC 0,67 (IC 0,53–0,80) y 0,72 dentro de cada centro, pero la permutación del desenlace dentro de cada centro no la distingue del azar (p ≈ 0,07) y se probaron 11 variantes: es exploratorio, no un modelo validado. El TCI (absoluto o de patrón) contra los controles públicos no tiene señal, y el puntaje de patrón diabético sólo discrimina entre centros (0,50 dentro de centro).',
    };
  }
  if (pub) {
    doc.basePublica = {
      etiqueta: 'Diabetes vs control (Hernández-Contreras et al. 2019, CC BY 4.0)',
      metodo:
        'Un sujeto por fila; 5 pliegues estratificados × 20 repeticiones, C anidado (CNN: 5 × 4). IC 95 % por bootstrap de sujetos.',
      modelos: pub.modelos
        .filter((m) => NOMBRES_PUB[m.modelo])
        .map((m) => ({
          modelo: m.modelo,
          nombre: NOMBRES_PUB[m.modelo],
          auc: r3(m.aucMedia),
          aucIC95: m.aucIC95,
          n: m.n,
          positivos: m.positivos,
          pPermutacion: m.pPermutacion ?? null,
        })),
      subgrupoEdad: pub.subgrupoEdad || null,
      tciClases: pub.tciClases || null,
      externa: pub.externa || null,
    };
  }
  doc.conclusion =
    'Con el desenlace sustituto (HbA1c > 7 %) ningún modelo muestra una señal convincente; el TCI absoluto se confunde con el centro de atención. Por eso el portal ya no muestra esa probabilidad: muestra el patrón térmico compatible con pie diabético, entrenado con etiqueta real en la base pública (no predice úlcera).';
  fs.writeFileSync(DEST, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`Actualizado ${path.relative(ROOT, DEST)}`);
}

main();
