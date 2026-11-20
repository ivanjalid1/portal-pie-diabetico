'use strict';

const PointwisePredictor = require('./PointwisePredictor');
const { decodeGrid } = require('../../imaging/pointwise');
const { hotspotFindings } = require('../../imaging/hotspot');
const { literatureRisk, EVIDENCIA, MODOS } = require('./literatureRisk');

/** Grillas de las tomas del análisis punto a punto, con sus zonas excluidas. */
const decodeTomas = (puntual) =>
  puntual.tomas
    .filter((t) => t.izq && t.der && t.metricas)
    .map((t) => ({
      toma: t.toma,
      izq: decodeGrid(t.izq),
      der: decodeGrid(t.der),
      zonasExcluidas: t.zonasNoAnalizadas || [],
    }));

/**
 * Hallazgo que entra al riesgo hasta la toma `hasta`: la asimetría de zona
 * caliente contigua de la última toma y, con dos tomas, la persistente entre
 * ambas (confirmación, como las dos mediciones consecutivas de los estudios).
 */
function hallazgoDe(findings, hasta = Infinity) {
  const tomas = findings.porToma.filter((t) => t.toma <= hasta);
  if (!tomas.length) return null;
  const ultima = tomas.at(-1);
  const conf = tomas.length >= 2 && findings.persistente ? findings.persistente.asimetria : null;
  return { ...ultima, confirmada: conf, tomas: tomas.length };
}

/**
 * Estrategia por defecto (`riesgo-bibliografia`): el mismo análisis punto a
 * punto que `PointwisePredictor` y, sobre él, el RIESGO DE ÚLCERA en el
 * horizonte configurado, calibrado con la evidencia publicada
 * (src/services/predictors/literatureRisk.js): prior del grupo IWGDF del
 * paciente × LR de la banda de asimetría contralateral de zona caliente
 * contigua (src/imaging/hotspot.js).
 *
 * `probabilidad` y `categoria` pasan a ser las del riesgo de úlcera; el patrón
 * térmico compatible con pie diabético queda como dato secundario.
 */
class LiteratureRiskPredictor extends PointwisePredictor {
  get info() {
    const base = super.info;
    return {
      ...base,
      id: 'riesgo-bibliografia',
      version: 'riesgo-bibliografia-v2',
      nombre: 'Riesgo de úlcera calibrado con la bibliografía (análisis punto a punto)',
      descripcion:
        'Probabilidad de úlcera en el horizonte configurado: incidencia del grupo de riesgo IWGDF del paciente (Peters y Lavery 2001) ajustada por el cociente de verosimilitud de la asimetría térmica contralateral (Frykberg et al. 2017), medida punto a punto en zonas calientes contiguas y, con dos tomas, persistente entre ambas.',
      riesgo: { evidencia: EVIDENCIA, modos: MODOS },
    };
  }

  /** Riesgo bibliográfico de un análisis ya calculado (`out` de PointwisePredictor). */
  static applyRisk(out, patient, p) {
    if (!out.puntual) return out;
    const tomas = decodeTomas(out.puntual);
    if (!tomas.length) return out;
    const findings = hotspotFindings(tomas, { umbral: p.umbralPixel ?? 1 });
    const riesgo = literatureRisk(hallazgoDe(findings), patient, p);
    riesgo.porToma = findings.porToma.map((f) => ({ toma: f.toma, asimetria: f.asimetria, areaPct: f.areaPct }));
    // Riesgo de cada toma para la evolución: la toma 1 sola y, desde la toma 2, el del estudio.
    for (const t of out.puntual.tomas) {
      const h = hallazgoDe(findings, t.toma);
      const r = h ? literatureRisk(h, patient, p) : null;
      t.riesgo = r ? { probabilidad: r.probabilidad, rango: r.rango } : null;
    }
    out.puntual.riesgo = riesgo;
    out.puntual.categoriaPor = 'riesgo_bibliografia';
    return {
      ...out,
      probabilidad: riesgo.probabilidad,
      categoria: riesgo.categoria,
      horizonteSemanas: riesgo.horizonteSemanas,
      // Los factores del modelo HbA1c (retirado) no describen este riesgo.
      factores: [],
    };
  }

  /** Parámetros del riesgo; las subclases pueden agregar datos estimados (p. ej. probNeuropatia). */
  // eslint-disable-next-line no-unused-vars
  riskParams(out, input) {
    return out.parametros || {};
  }

  async predict(input) {
    const out = await super.predict(input);
    const p = this.riskParams(out, input);
    const res = LiteratureRiskPredictor.applyRisk(out, input.patient, p);
    return { ...res, predictorVersion: this.info.version };
  }
}

module.exports = LiteratureRiskPredictor;
module.exports.hallazgoDe = hallazgoDe;
