'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { GRID, ZONAS, zonaDeFila, decodeGrid } = require('../imaging/pointwise');

/**
 * Pronóstico de la evolución térmica POR ZONA para el próximo control.
 *
 * Unidad: pie × zona (dedos, metatarso, arco, talón) sobre la grilla canónica
 * registrada. Para cada pie y zona:
 *  - % de área caliente: celdas de la zona en las que ESE pie está más de
 *    `umbral` °C más caliente que el mismo punto del pie contralateral;
 *  - ΔT orientado: media de (este pie − contralateral) en la zona (°C).
 *
 * Los modelos (scripts/ml/train_forecast.py, entrenados con los pares
 * toma 1 → toma 2 de la cohorte, validación cruzada por paciente) son:
 *  - área esperada = a + b · área actual (regresión a la media), con un rango
 *    del 80 % tomado de los residuos de la validación cruzada;
 *  - ΔT esperado: el mismo enfoque;
 *  - P(zona ≥ umbral de área en el próximo control): logística sobre el área y
 *    el ΔT actuales, recalibrada con la validación cruzada;
 *  - mapa de ΔT esperado por punto: β · ΔT actual (encogimiento).
 *
 * El archivo de coeficientes deriva de datos reales: vive en
 * data-local/models/forecast-zones.json (ignorada por git y Vercel) y no tiene
 * datos de pacientes. PRONOSTICO_MODELO cambia la ruta. Sin archivo (CI,
 * Vercel) no hay pronóstico; la marca de «zona caliente persistente» no usa el
 * modelo y se calcula igual.
 */
const FORECAST_MODEL_PATH =
  process.env.PRONOSTICO_MODELO || path.join(__dirname, '..', '..', 'data-local', 'models', 'forecast-zones.json');

const PIES = Object.freeze(['izq', 'der']);
const PIE_NOMBRE = Object.freeze({ izq: 'izquierdo', der: 'derecho' });
const PIE_CORTO = Object.freeze({ izq: 'izq.', der: 'der.' });
const ZONA_NOMBRE = Object.freeze(Object.fromEntries(ZONAS.map((z) => [z.key, z.nombre])));

const valid = Number.isFinite;
const r1 = (v) => (valid(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v) => (valid(v) ? Math.round(v * 100) / 100 : null);
const r3 = (v) => (valid(v) ? Math.round(v * 1000) / 1000 : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * Variables por pie y zona de una toma (las mismas que usa el entrenamiento:
 * scripts/ml/export-forecast.js llama a esta función).
 * @param {Float32Array} izq grilla canónica del pie izquierdo
 * @param {Float32Array} der grilla canónica del pie derecho (espejado)
 * @returns {{izq: Object<string, {areaPct:number, dT:number, celdas:number}|null>, der: Object}}
 */
function zoneFeatures(izq, der, { umbral = 1, excluidas = [] } = {}) {
  const acc = {};
  for (const z of ZONAS) acc[z.key] = { n: 0, calIzq: 0, calDer: 0, suma: 0 };
  for (let r = 0; r < GRID.h; r += 1) {
    const zona = zonaDeFila(r).key;
    if (excluidas.includes(zona)) continue;
    const a = acc[zona];
    for (let c = 0; c < GRID.w; c += 1) {
      const i = r * GRID.w + c;
      if (!valid(izq[i]) || !valid(der[i])) continue;
      const d = izq[i] - der[i];
      a.n += 1;
      a.suma += d;
      if (d > umbral) a.calIzq += 1;
      else if (-d > umbral) a.calDer += 1;
    }
  }
  const out = { izq: {}, der: {} };
  for (const z of ZONAS) {
    const a = acc[z.key];
    if (!a.n) {
      out.izq[z.key] = null;
      out.der[z.key] = null;
      continue;
    }
    const media = a.suma / a.n;
    out.izq[z.key] = { areaPct: (100 * a.calIzq) / a.n, dT: media, celdas: a.n };
    out.der[z.key] = { areaPct: (100 * a.calDer) / a.n, dT: -media, celdas: a.n };
  }
  return out;
}

/** Variables por zona de una toma del análisis punto a punto (o null). */
function featuresOfToma(t, umbral) {
  if (!t?.izq || !t?.der) return null;
  return zoneFeatures(decodeGrid(t.izq), decodeGrid(t.der), { umbral, excluidas: t.zonasNoAnalizadas || [] });
}

function loadForecastModel(file = FORECAST_MODEL_PATH) {
  // Las pruebas no dependen de un modelo local derivado de datos reales.
  if (process.env.NODE_ENV === 'test' && !process.env.PRONOSTICO_MODELO && file === FORECAST_MODEL_PATH) return null;
  try {
    const m = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    return isUsable(m) ? m : null;
  } catch {
    return null;
  }
}

/** Coeficientes mínimos para pronosticar. */
function isUsable(m) {
  return Boolean(
    m &&
    valid(m.area?.intercepto) &&
    valid(m.area?.pendiente) &&
    Array.isArray(m.area?.rango80) &&
    valid(m.dT?.intercepto) &&
    valid(m.dT?.pendiente) &&
    valid(m.prob?.intercepto) &&
    valid(m.prob?.coefArea) &&
    valid(m.prob?.coefDT),
  );
}

/** Tolerancia por defecto de la tendencia (pp): la de Configuración si no se indica. */
const TOLERANCIA_DEFECTO = 6;

class ThermalForecastService {
  /**
   * @param {{model?: object|null, file?: string}} opts  `model` explícito (pruebas) o ruta del archivo
   */
  constructor({ model, file = FORECAST_MODEL_PATH } = {}) {
    this.model = model === undefined ? loadForecastModel(file) : isUsable(model) ? model : null;
  }

  get disponible() {
    return Boolean(this.model);
  }

  /** Métricas del modelo para «Detalle técnico» (o null). */
  get info() {
    const m = this.model;
    if (!m) return null;
    return {
      version: m.version,
      horizonteDias: m.horizonteDias,
      n: m.n,
      umbralPixel: m.umbralPixel,
      areaUmbral: m.areaUmbral,
      area: { ...m.area.cv, intercepto: m.area.intercepto, pendiente: m.area.pendiente, rango80: m.area.rango80 },
      dT: { ...m.dT.cv, intercepto: m.dT.intercepto, pendiente: m.dT.pendiente },
      prob: m.prob.cv,
      empeora: m.empeora || null,
      pixel: m.pixel || null,
      retest: m.retest || null,
    };
  }

  /** Área esperada (%) con su rango del 80 %, acotada a 0–100. */
  #area(actual, modelo = this.model.area) {
    const e = modelo.intercepto + modelo.pendiente * actual;
    const [lo, hi] = modelo.rango80;
    return { esperado: clamp(e, 0, 100), rango: [clamp(e + lo, 0, 100), clamp(e + hi, 0, 100)] };
  }

  #dT(actual) {
    const m = this.model.dT;
    const e = m.intercepto + m.pendiente * actual;
    const [lo, hi] = m.rango80 || [0, 0];
    return { esperado: e, rango: [e + lo, e + hi] };
  }

  /** P(zona con ≥ areaUmbral % de área caliente en el próximo control), recalibrada. */
  #prob(area, dT) {
    const p = this.model.prob;
    const lin = p.intercepto + p.coefArea * (area / 10) + p.coefDT * dT;
    const cal = p.calibracion || { intercepto: 0, pendiente: 1 };
    return sigmoid(cal.intercepto + cal.pendiente * lin);
  }

  /**
   * Pronóstico de un análisis: desde su última toma, por pie y zona.
   * @param {object} analysis AnalysisResult (o su forma plana) con `puntual`
   * @param {{tolerancia?: number, areaMinima?: number}} opts
   *   tolerancia: diferencia esperada − actual (pp) para «empeora» / «mejora»;
   *   areaMinima: área (%) para la marca de zona caliente persistente.
   */
  forAnalysis(analysis, { tolerancia = TOLERANCIA_DEFECTO, areaMinima } = {}) {
    const P = analysis?.puntual;
    if (!P || !Array.isArray(P.tomas) || !P.tomas.length) return null;
    const tomas = P.tomas.filter((t) => t.izq && t.der && t.metricas);
    if (!tomas.length) return null;
    const actual = tomas.at(-1);
    const previa = tomas.length >= 2 ? tomas.at(-2) : null;
    const m = this.model;
    // El modelo se entrenó con su umbral por punto; sin modelo, el del análisis.
    const umbral = m ? m.umbralPixel : (P.umbralPixel ?? 1);
    const corte = valid(areaMinima) ? areaMinima : (P.areaMinima ?? 10);
    const fA = featuresOfToma(actual, umbral);
    const fP = previa ? featuresOfToma(previa, umbral) : null;
    // La persistencia usa el umbral por punto del análisis (el que se ve en los mapas).
    const umbralVista = P.umbralPixel ?? 1;
    const vA = umbralVista === umbral ? fA : featuresOfToma(actual, umbralVista);
    const vP = previa ? (umbralVista === umbral ? fP : featuresOfToma(previa, umbralVista)) : null;

    const pies = PIES.map((pie) => ({
      pie,
      nombre: PIE_NOMBRE[pie],
      zonas: ZONAS.map((z) => {
        const a = fA[pie][z.key];
        const persistente = Boolean(
          vP && vA[pie][z.key] && vP[pie][z.key] && vA[pie][z.key].areaPct >= corte && vP[pie][z.key].areaPct >= corte,
        );
        const fila = {
          zona: z.key,
          nombre: z.nombre,
          actual: a ? { areaPct: r1(a.areaPct), dT: r2(a.dT) } : null,
          previo: fP && fP[pie][z.key] ? { areaPct: r1(fP[pie][z.key].areaPct), dT: r2(fP[pie][z.key].dT) } : null,
          persistente,
          esperado: null,
          prob: null,
          tendencia: null,
        };
        if (m && a) {
          const ar = this.#area(a.areaPct);
          const dt = this.#dT(a.dT);
          const delta = ar.esperado - a.areaPct;
          fila.esperado = {
            areaPct: r1(ar.esperado),
            rango: ar.rango.map(r1),
            dT: r2(dt.esperado),
            dTRango: dt.rango.map(r2),
          };
          fila.prob = r3(this.#prob(a.areaPct, a.dT));
          fila.tendencia = delta > tolerancia ? 'empeora' : delta < -tolerancia ? 'mejora' : 'estable';
        }
        return fila;
      }),
    }));

    const filas = pies.flatMap((p) => p.zonas.map((z) => ({ ...z, pie: p.pie })));
    const persistentes = filas
      .filter((z) => z.persistente)
      .map((z) => ({
        pie: z.pie,
        zona: z.zona,
        texto: `${ZONA_NOMBRE[z.zona]} ${PIE_CORTO[z.pie]}`,
        areaPct: [z.previo ? z.previo.areaPct : null, z.actual.areaPct],
      }));

    const out = {
      disponible: Boolean(m),
      desdeToma: actual.toma,
      tomas: tomas.length,
      tolerancia,
      areaMinima: corte,
      areaUmbral: m ? m.areaUmbral : null,
      umbralPixel: umbral,
      pies,
      persistentes,
      peor: null,
      planta: null,
      beta: null,
      horizonteDias: m ? m.horizonteDias : null,
      version: m ? m.version : null,
    };
    if (!m) return out;

    // Zona con mayor área esperada (o mayor probabilidad si empatan).
    const conPron = filas.filter((z) => z.esperado);
    if (conPron.length) {
      const w = conPron.reduce((b, z) =>
        z.esperado.areaPct > b.esperado.areaPct || (z.esperado.areaPct === b.esperado.areaPct && z.prob > b.prob)
          ? z
          : b,
      );
      out.peor = {
        pie: w.pie,
        zona: w.zona,
        texto: `${ZONA_NOMBRE[w.zona]} ${PIE_CORTO[w.pie]}`,
        actual: w.actual.areaPct,
        esperado: w.esperado.areaPct,
        rango: w.esperado.rango,
        tendencia: w.tendencia,
        prob: w.prob,
      };
    }
    // Planta completa (la serie del gráfico de evolución: % de la planta con |ΔT| > umbral).
    const mA = actual.metricas;
    if (m.planta && mA && valid(mA.areaCalientePct) && (P.umbralPixel ?? 1) === m.umbralPixel) {
      const pl = this.#area(mA.areaCalientePct, m.planta);
      out.planta = { actual: r1(mA.areaCalientePct), esperado: r1(pl.esperado), rango: pl.rango.map(r1) };
    }
    if (m.pixel && valid(m.pixel.beta)) out.beta = m.pixel.beta;
    return out;
  }
}

module.exports = ThermalForecastService;
module.exports.ThermalForecastService = ThermalForecastService;
module.exports.zoneFeatures = zoneFeatures;
module.exports.loadForecastModel = loadForecastModel;
module.exports.isUsable = isUsable;
module.exports.FORECAST_MODEL_PATH = FORECAST_MODEL_PATH;
module.exports.ZONA_NOMBRE = ZONA_NOMBRE;
module.exports.PIE_NOMBRE = PIE_NOMBRE;
