'use strict';

/**
 * Datos para el pronóstico térmico por zona (scripts/ml/train_forecast.py).
 *
 * Pares toma 1 → toma 2 de los pacientes con consentimiento y ambas tomas
 * analizables (data-local/real/dataset.json):
 *   data-local/ml/forecast/pairs.f32        grillas canónicas 40 × 100 en °C
 *                                           (n, toma, pie [izq, der], 100, 40); NaN = sin dato
 *   data-local/ml/forecast/pairs-meta.json  por par: índice anónimo, centro
 *                                           codificado, días entre tomas, zonas no
 *                                           analizadas y las variables por pie × zona
 *                                           de cada toma (las de ThermalForecastService)
 *
 * Con --retest también exporta el ruido test-retest: réplicas de la MISMA toma
 * (minutos de diferencia) leídas de los IS2 originales con las máscaras U-Net:
 *   data-local/ml/forecast/retest-zones.json  variables por zona de cada par de
 *                                             réplicas y MAE de ΔT por punto
 * Con --retest-json <archivo> se reutilizan grillas de réplicas ya exportadas
 * (formato [{ toma, reps: [{ izq: number[], der: number[] }] }]).
 *
 * No escribe identidades: sólo índices anónimos y números. Los IS2 se leen como
 * datos; nunca se ejecuta nada de la carpeta privada.
 *
 * Con --train, al terminar entrena los modelos con el Python del entorno local
 * (data-local/venv-ml, o la variable PYTHON): scripts/ml/train_forecast.py.
 *
 * Uso: node scripts/ml/export-forecast.js [--retest | --retest-json <archivo>] [--train]
 *      npm run ml:forecast   (= exportar los pares y entrenar; reutiliza el test-retest exportado)
 */
const fs = require('node:fs');
const path = require('node:path');
const { decodeGrid, zoneCoverage, asymmetryMetrics } = require('../../src/imaging/pointwise');
const { sinConsentimiento } = require('../../src/seed/realData');
const { zoneFeatures } = require('../../src/services/ThermalForecastService');
const { COBERTURA_MINIMA } = require('../../src/services/predictors/pointwiseAnalysis');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data-local', 'ml', 'forecast');
const UMBRAL = 1.0; // °C por punto (el valor por defecto del portal)

const excluidasDe = (izq, der) =>
  Object.entries(zoneCoverage(izq, der))
    .filter(([, v]) => v < COBERTURA_MINIMA)
    .map(([k]) => k);

/** Variables de una toma: por pie × zona, más el % de la planta con |ΔT| > umbral. */
function tomaFeatures(izq, der) {
  const excluidas = excluidasDe(izq, der);
  const z = zoneFeatures(izq, der, { umbral: UMBRAL, excluidas });
  const m = asymmetryMetrics(izq, der, { umbralPixel: UMBRAL, zonasExcluidas: excluidas });
  const round = (o) => (o ? { areaPct: +o.areaPct.toFixed(3), dT: +o.dT.toFixed(4), celdas: o.celdas } : null);
  return {
    excluidas,
    zonas: {
      izq: Object.fromEntries(Object.entries(z.izq).map(([k, v]) => [k, round(v)])),
      der: Object.fromEntries(Object.entries(z.der).map(([k, v]) => [k, round(v)])),
    },
    plantaPct: m ? +m.areaCalientePct.toFixed(3) : null,
  };
}

function exportPairs() {
  const { pacientes } = JSON.parse(fs.readFileSync(path.join(ROOT, 'data-local', 'real', 'dataset.json'), 'utf8'));
  const fechaOk = (iso) => Boolean(iso) && new Date(iso).getFullYear() >= 2020;
  const centros = {};
  const meta = [];
  const grids = [];
  for (const p of pacientes) {
    if (sinConsentimiento(p)) continue;
    const t1 = p.tomas.find((t) => t.toma === 1 && t.ok);
    const t2 = p.tomas.find((t) => t.toma === 2 && t.ok);
    if (!t1 || !t2) continue;
    const f1 = fechaOk(t1.fecha) ? t1.fecha : p.fechaToma1Planilla ? `${p.fechaToma1Planilla}T12:00:00Z` : null;
    const f2 = fechaOk(t2.fecha) ? t2.fecha : null;
    const estimada = !fechaOk(t1.fecha) || !f2;
    const dias = f1 && f2 ? (new Date(f2) - new Date(f1)) / 864e5 : null;
    if (!(p.centro in centros)) centros[p.centro] = Object.keys(centros).length;
    const g = [t1, t2].map((t) => ({ izq: decodeGrid(t.izq), der: decodeGrid(t.der) }));
    meta.push({
      i: meta.length,
      centro: centros[p.centro],
      noValido: Boolean(p.clinica?.noValido),
      dias: dias === null ? null : Math.round(dias),
      estimada,
      tomas: g.map((t) => tomaFeatures(t.izq, t.der)),
    });
    for (const t of g) grids.push(t.izq, t.der);
  }
  const buf = new Float32Array(grids.length * grids[0].length);
  grids.forEach((g, k) => buf.set(g, k * g.length));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'pairs.f32'), Buffer.from(buf.buffer));
  fs.writeFileSync(
    path.join(OUT, 'pairs-meta.json'),
    JSON.stringify({
      shape: [meta.length, 2, 2, 100, 40],
      umbralPixel: UMBRAL,
      ncentros: Object.keys(centros).length,
      meta,
    }),
  );
  const d = meta.filter((m) => !m.estimada && m.dias !== null).map((m) => m.dias);
  console.log(`pares ${meta.length} · centros ${Object.keys(centros).length} · días con fecha registrada ${d.length}`);
}

/** Variables de cada par de réplicas de una misma sesión. */
function retestFromSessions(sessions) {
  const out = [];
  for (const [si, s] of sessions.entries()) {
    const reps = s.reps.map((r) => {
      const izq = Float32Array.from(r.izq, (v) => (v === null ? NaN : v));
      const der = Float32Array.from(r.der, (v) => (v === null ? NaN : v));
      return { izq, der, f: tomaFeatures(izq, der) };
    });
    for (let a = 0; a < reps.length; a += 1) {
      for (let b = a + 1; b < reps.length; b += 1) {
        const A = reps[a];
        const B = reps[b];
        let n = 0;
        let sum = 0;
        for (let i = 0; i < A.izq.length; i += 1) {
          const da = A.izq[i] - A.der[i];
          const db = B.izq[i] - B.der[i];
          if (!Number.isFinite(da) || !Number.isFinite(db)) continue;
          n += 1;
          sum += Math.abs(da - db);
        }
        out.push({ sesion: si, toma: s.toma, a: A.f.zonas, b: B.f.zonas, pixelMae: n ? +(sum / n).toFixed(4) : null });
      }
    }
  }
  return out;
}

function retestFromIs2() {
  const { analyzeIs2Pointwise, labelsToMasks } = require('../../src/imaging/pointwise');
  const { readNpy, is2Key } = require('../lib/npy');
  const PRIVATE = path.join(ROOT, 'tesis-2026info');
  const DIRS = {
    1: path.join(PRIVATE, 'PRIMERAS FOTOS', 'PRIMERAS FOTOS'),
    2: path.join(PRIVATE, 'SEGUNDA TOMA DE FOTOS'),
  };
  const CODE_RE = /^2?P\.?\s*(VHF|HC|RF)\.?\s*(\d{3})/i;
  const parse = (d) => {
    const m = CODE_RE.exec(d.trim());
    return m ? `P.${m[1].toUpperCase()}${m[2]}` : null;
  };
  const { pacientes } = JSON.parse(fs.readFileSync(path.join(ROOT, 'data-local', 'real', 'dataset.json'), 'utf8'));
  const okCodes = new Set(pacientes.filter((p) => !sinConsentimiento(p)).map((p) => p.codigo));
  const masksOf = (file) => {
    const f = path.join(ROOT, 'data-local', 'ml', 'unet-masks', `${is2Key(PRIVATE, file)}.npy`);
    if (!fs.existsSync(f)) return null;
    try {
      return labelsToMasks(readNpy(f).data);
    } catch {
      return null;
    }
  };
  const sessions = [];
  for (const toma of [1, 2]) {
    for (const site of fs.readdirSync(DIRS[toma])) {
      const sd = path.join(DIRS[toma], site);
      if (!fs.statSync(sd).isDirectory()) continue;
      for (const d of fs.readdirSync(sd)) {
        const code = parse(d);
        if (!code || !okCodes.has(code)) continue;
        const dir = path.join(sd, d);
        if (!fs.statSync(dir).isDirectory()) continue;
        const files = fs
          .readdirSync(dir)
          .filter((f) => /\.is2$/i.test(f))
          .sort()
          .map((f) => path.join(dir, f));
        if (files.length < 2) continue;
        const reps = [];
        for (const file of files) {
          try {
            const m = masksOf(file);
            const r = analyzeIs2Pointwise(fs.readFileSync(file), m ? { masks: m, masksSource: 'unet' } : {});
            if (r.ok) reps.push({ izq: Array.from(decodeGrid(r.izq)), der: Array.from(decodeGrid(r.der)) });
          } catch {
            /* réplica ilegible */
          }
        }
        if (reps.length >= 2) sessions.push({ toma, reps });
      }
    }
  }
  return sessions;
}

function exportRetest(sessions) {
  const pares = retestFromSessions(sessions);
  fs.writeFileSync(
    path.join(OUT, 'retest-zones.json'),
    JSON.stringify({ umbralPixel: UMBRAL, sesiones: sessions.length, pares }),
  );
  console.log(`test-retest: ${sessions.length} sesiones con ≥ 2 réplicas, ${pares.length} pares de réplicas`);
}

const args = process.argv.slice(2);
exportPairs();
const j = args.indexOf('--retest-json');
if (j >= 0) exportRetest(JSON.parse(fs.readFileSync(args[j + 1], 'utf8')));
else if (args.includes('--retest')) exportRetest(retestFromIs2());

if (args.includes('--train')) {
  const { spawnSync } = require('node:child_process');
  const venv = path.join(
    ROOT,
    'data-local',
    'venv-ml',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  const python = process.env.PYTHON || (fs.existsSync(venv) ? venv : 'python');
  const r = spawnSync(python, ['-I', path.join(__dirname, 'train_forecast.py')], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
