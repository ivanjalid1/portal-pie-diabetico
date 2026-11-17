#!/usr/bin/env node
'use strict';

/**
 * Entrena el modelo PRELIMINAR de regresión logística sobre features punto a
 * punto, con el mismo desenlace sustituto de la Parte 1 (HbA1c > 7 %).
 *
 * Entrada: data-local/real/dataset.json (scripts/precompute-real.js, local).
 * Muestra: pacientes con HbA1c, toma 1 analizable y no marcados en la planilla
 * como «PACIENTE NO VALIDO» (criterio de exclusión de la Parte 1).
 * Validación: leave-one-out (estandarización dentro de cada pliegue), AUC con
 * intervalo bootstrap del 95 %, y como control 5 pliegues estratificados
 * repetidos 20 veces. C = 0,5 como en la Parte 1.
 *
 * Salida: src/config/models/pointwise-logreg.json con coeficientes, medias,
 * desvíos y métricas AGREGADAS (n, AUC). No contiene códigos, fechas ni
 * ningún dato por paciente, por eso puede versionarse.
 *
 * Además informa (sólo por consola) la concordancia entre el ΔT general por
 * regiones calculado desde la grilla y el de la planilla de la Parte 1.
 */
const fs = require('node:fs');
const path = require('node:path');
const { analyzePointwise } = require('../src/services/predictors/pointwiseAnalysis');
const { FEATURES, MODEL_PATH, featureVector } = require('../src/services/predictors/pointwiseModel');
const L = require('../src/services/predictors/logistic');
const { sinConsentimiento } = require('../src/seed/realData');

const DATASET = path.join(__dirname, '..', 'data-local', 'real', 'dataset.json');
const UMBRAL = 1.0;
const C = 0.5;

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

function main() {
  if (!fs.existsSync(DATASET)) {
    console.error('Falta data-local/real/dataset.json: ejecutá antes scripts/precompute-real.js.');
    process.exit(1);
  }
  const { pacientes } = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
  const X = [];
  const y = [];
  let excluidosNoValido = 0;
  let sinHba1c = 0;
  const concord = { nuestro: [], parte1: [] };
  for (const p of pacientes) {
    if (sinConsentimiento(p)) continue; // nunca se usan pacientes sin consentimiento
    const t1 = p.tomas.find((t) => t.toma === 1 && t.ok);
    if (!t1) continue;
    const puntual = analyzePointwise({ toma1: t1 }, { umbralPixel: UMBRAL });
    const gen = puntual.rois.toma1?.find((r) => r.roi === 'general');
    const anaGen = p.ana?.rois.find((r) => r.roi === 'general');
    if (gen && anaGen) {
      concord.nuestro.push(gen.deltaT);
      concord.parte1.push(anaGen.avgDer - anaGen.avgIzq);
    }
    if (p.clinica?.noValido) {
      excluidosNoValido += 1;
      continue;
    }
    if (p.clinica?.hba1c === null || p.clinica?.hba1c === undefined) {
      sinHba1c += 1;
      continue;
    }
    const x = featureVector(puntual.tomas[0], { umbralPixel: UMBRAL });
    if (!x) continue;
    X.push(x);
    y.push(p.clinica.hba1c > 7 ? 1 : 0);
  }
  const positivos = y.filter((v) => v === 1).length;
  const loo = L.looPredictions(X, y, { C });
  const aucLoo = L.auc(loo, y);
  const [lo, hi] = L.bootstrapAuc(loo, y);
  const kf = L.repeatedKFoldAuc(X, y, { k: 5, reps: 20, C });
  const aucKf = kf.reduce((a, b) => a + b, 0) / kf.length;
  const aucUni = FEATURES.map((f, j) => ({
    key: f.key,
    auc: L.auc(
      X.map((x) => x[j]),
      y,
    ),
  }));

  const scale = L.standardize(X);
  const model = L.fitLogistic(
    X.map((x) => L.applyScale(x, scale)),
    y,
    { C },
  );
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const out = {
    _descripcion:
      'Modelo PRELIMINAR (regresión logística L2) sobre features punto a punto de la toma 1. Generado por scripts/train-pointwise-model.js. Sólo contiene parámetros y métricas agregadas.',
    version: 'puntual-logreg-v1',
    generado: new Date().toISOString().slice(0, 10),
    desenlace: 'HbA1c > 7 % (sustituto, igual que la Parte 1)',
    umbralPixel: UMBRAL,
    C,
    intercepto: r3(model.intercepto),
    features: FEATURES.map((f, j) => ({
      key: f.key,
      nombre: f.nombre,
      unidad: f.unidad,
      media: r3(scale.media[j]),
      desvio: r3(scale.desvio[j]),
      coef: r3(model.coef[j]),
    })),
    validacion: {
      metodo: 'Leave-One-Out',
      n: y.length,
      positivos,
      auc: r3(aucLoo),
      aucIC95: [r3(lo), r3(hi)],
      kFold: { metodo: '5 pliegues estratificados × 20 repeticiones', aucMedia: r3(aucKf) },
      aucPorFeature: aucUni.map((a) => ({ key: a.key, auc: r3(a.auc) })),
    },
    muestra: {
      criterio:
        'Pacientes con HbA1c registrada y toma 1 analizable; se excluyen los marcados «PACIENTE NO VALIDO» en la planilla (criterio de la Parte 1).',
    },
  };
  fs.mkdirSync(path.dirname(MODEL_PATH), { recursive: true });
  fs.writeFileSync(MODEL_PATH, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `n = ${y.length} (positivos ${positivos}); excluidos no válidos: ${excluidosNoValido}; sin HbA1c: ${sinHba1c}`,
  );
  console.log(`AUC LOO = ${r3(aucLoo)} (IC95 bootstrap ${r3(lo)}–${r3(hi)})`);
  console.log(`AUC 5-fold ×20 (media) = ${r3(aucKf)}`);
  console.log('AUC univariado:', aucUni.map((a) => `${a.key} ${r3(a.auc)}`).join(', '));
  console.log('Coeficientes (estandarizados):', out.features.map((f) => `${f.key} ${f.coef}`).join(', '));
  if (concord.nuestro.length > 2) {
    const diffs = concord.nuestro.map((v, i) => Math.abs(v - concord.parte1[i]));
    console.log(
      `Concordancia ΔT general (der − izq) grilla vs planilla Parte 1: n = ${concord.nuestro.length}, r = ${r3(
        pearson(concord.nuestro, concord.parte1),
      )}, |dif| mediana = ${r3(diffs.sort((a, b) => a - b)[Math.floor(diffs.length / 2)])} °C`,
    );
  }
  console.log(`Modelo: ${path.relative(path.join(__dirname, '..'), MODEL_PATH)}`);
}

main();
