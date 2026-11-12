'use strict';

const UlcerPredictor = require('./UlcerPredictor');
const { seededRandom, round } = require('../../utils/random');
const {
  ROIS,
  categoryFor,
  HORIZONTE_SEMANAS,
  DELTA_T_UMBRAL,
  thermalGroup,
  CAMBIO_SIGNIFICATIVO,
} = require('../../config/domain');

/** Desplazamientos térmicos típicos de cada ROI respecto de la media plantar (°C). */
const ROI_OFFSET = {
  dedo_mayor: -0.5,
  dedos_menores: -0.9,
  metatarso: 0.4,
  arco_interno: 0.9,
  arco_externo: 0.3,
  talon: -0.2,
};

const GRADE_INDEX = { Normal: 0, Leve: 1, Moderada: 2, Grave: 3 };

/**
 * Coeficientes ilustrativos (log-odds). NO provienen de un ajuste real: sólo
 * producen resultados verosímiles y coherentes con los factores de riesgo
 * reportados en la Parte 1, para poder validar el flujo completo del portal.
 */
const COEF = {
  intercepto: -2.3,
  tabaquismo: 0.85,
  insulinorequiriente: 0.7,
  aniosDm: 0.04,
  gradoNeuropatia: 0.3,
  deltaDedoMayor: 0.55,
  deltaMetatarso: 0.45,
  evolucion: 1.1,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function summarize(rois, umbral) {
  const regionales = rois.filter((r) => r.roi !== 'general');
  const maxRow = regionales.reduce((m, r) => (Math.abs(r.deltaT) > Math.abs(m.deltaT) ? r : m), regionales[0]);
  return { ...thermalGroup(rois, umbral), deltaTMax: maxRow.deltaT, deltaTMaxRoi: maxRow.roi };
}

/**
 * Estrategia simulada (`mock-v0`) para el análisis comparativo de dos tomas.
 *
 * Las temperaturas por ROI de cada toma se obtienen, por orden de preferencia:
 *  1. de `hints` (ROIs ya estimadas, p. ej. las de las imágenes demo);
 *  2. de los archivos .IS2 subidos, con una segmentación simple de la matriz
 *     IR (src/imaging) — `fuenteRois = 'is2'`;
 *  3. de una simulación determinística a partir del código del paciente y
 *     las fechas (`fuenteRois = 'simulada'`).
 *
 * La probabilidad es SIEMPRE simulada: combina factores clínicos, la
 * asimetría de la toma 2 y el empeoramiento de la asimetría entre tomas.
 */
class MockUlcerPredictor extends UlcerPredictor {
  constructor({ umbral = DELTA_T_UMBRAL } = {}) {
    super();
    this.umbral = umbral;
  }

  get info() {
    return {
      id: 'mock',
      version: 'mock-v0',
      nombre: 'Predictor simulado',
      descripcion:
        'Compara la toma 1 y la toma 2 por ROI. Las temperaturas provienen del IS2 cuando es posible; la probabilidad es simulada.',
    };
  }

  /** Riesgo clínico normalizado (0–1) usado para dar verosimilitud a la simulación. */
  static severity(patient, rnd) {
    const anios = clamp(patient.aniosEvolucionDm || 0, 0, 25);
    const riesgo =
      (patient.tabaquismo ? 0.55 : 0) +
      (patient.insulinorequiriente ? 0.45 : 0) +
      anios * 0.025 +
      GRADE_INDEX[patient.gradoNeuropatia] * 0.3 +
      (patient.antecedenteUlcera ? 0.5 : 0);
    return clamp(riesgo / 2.6 + (rnd() * 2 - 1) * 0.18, 0.05, 1);
  }

  static simulateToma(rnd, { magnitud, lado, hotspot, ambiente }) {
    const noise = (amp) => (rnd() * 2 - 1) * amp;
    const base = 28.4 + ((ambiente ?? 22.5) - 22.5) * 0.4 + noise(1.4);
    const rows = [];
    for (const { key } of ROIS) {
      if (key === 'general') continue;
      const izq = clamp(base + ROI_OFFSET[key] + noise(0.35), 23, 33.5);
      let delta = noise(0.4);
      if (key === hotspot) delta = lado * clamp(magnitud + noise(0.15), 0, 2.8);
      else if (key === 'metatarso' || key === 'dedo_mayor') delta = lado * magnitud * 0.45 + noise(0.25);
      else if (key === 'dedos_menores') delta = lado * magnitud * 0.3 + noise(0.3);
      delta = clamp(delta, -2.8, 2.8);
      const der = clamp(izq + delta, 23, 34);
      const spread = () => 0.8 + rnd() * 0.8;
      rows.push({
        roi: key,
        avgDer: round(der, 2),
        avgIzq: round(izq, 2),
        maxDer: round(der + spread(), 2),
        maxIzq: round(izq + spread(), 2),
        minDer: round(der - spread() - 0.2, 2),
        minIzq: round(izq - spread() - 0.2, 2),
        deltaT: round(der - izq, 2),
      });
    }
    const mean = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
    const general = {
      roi: 'general',
      avgDer: round(mean('avgDer'), 2),
      avgIzq: round(mean('avgIzq'), 2),
      maxDer: round(Math.max(...rows.map((r) => r.maxDer)), 2),
      maxIzq: round(Math.max(...rows.map((r) => r.maxIzq)), 2),
      minDer: round(Math.min(...rows.map((r) => r.minDer)), 2),
      minIzq: round(Math.min(...rows.map((r) => r.minIzq)), 2),
    };
    general.deltaT = round(general.avgDer - general.avgIzq, 2);
    rows.push(general);
    return rows;
  }

  simulate({ patient, study }) {
    const seed = `${patient.codigo}|${String(study.fechaToma1 || '').slice(0, 10)}|${String(study.fechaHora).slice(0, 10)}`;
    const rnd = seededRandom(seed);
    const sev = MockUlcerPredictor.severity(patient, rnd);
    const hotspot = rnd() < 0.65 ? 'dedo_mayor' : 'metatarso';
    const lado = rnd() < 0.5 ? 1 : -1;
    const mag1 = Math.min(2.6, sev * 2.2);
    // Riesgo alto → la asimetría tiende a crecer entre tomas; bajo → a estabilizarse.
    const drift = (sev - 0.45) * 0.9 + (rnd() * 2 - 1) * 0.25;
    const mag2 = clamp(mag1 + drift, 0, 2.8);
    return {
      toma1: MockUlcerPredictor.simulateToma(rnd, {
        magnitud: mag1,
        lado,
        hotspot,
        ambiente: study.tempAmbienteToma1 ?? study.tempAmbiente,
      }),
      toma2: MockUlcerPredictor.simulateToma(rnd, { magnitud: mag2, lado, hotspot, ambiente: study.tempAmbiente }),
    };
  }

  /** Intenta estimar las ROIs desde archivos IS2 (decodificación real de la matriz IR). */
  static fromIs2(images) {
    const byslot = Object.fromEntries((images || []).map((i) => [i.slot, i]));
    const t1 = byslot.toma1;
    const t2 = byslot.toma2;
    if (!t1?.buffer || !t2?.buffer || t1.mime !== 'application/x-fluke-is2' || t2.mime !== 'application/x-fluke-is2') {
      return null;
    }
    try {
      const { decodeIs2 } = require('../../imaging/is2');
      const { analyzeThermogram, roisInCelsius } = require('../../imaging/thermogram');
      const a1 = analyzeThermogram(decodeIs2(t1.buffer));
      const a2 = analyzeThermogram(decodeIs2(t2.buffer));
      if (!a1.ok || !a2.ok) return null;
      const r1 = roisInCelsius(a1);
      const r2 = roisInCelsius(a2);
      return r1.length === ROIS.length && r2.length === ROIS.length ? { toma1: r1, toma2: r2 } : null;
    } catch {
      return null;
    }
  }

  async predict({ patient, study, images = [], hints = null }) {
    let fuenteRois = 'simulada';
    let tomas = null;
    if (hints?.toma1?.length && hints?.toma2?.length) {
      tomas = { toma1: hints.toma1, toma2: hints.toma2 };
      fuenteRois = hints.fuente || 'imagen';
    } else {
      tomas = MockUlcerPredictor.fromIs2(images);
      if (tomas) fuenteRois = 'is2';
      else tomas = this.simulate({ patient, study });
    }

    const s1 = summarize(tomas.toma1, this.umbral);
    const s2 = summarize(tomas.toma2, this.umbral);
    const dt = (rois, key) => Math.abs(rois.find((r) => r.roi === key)?.deltaT || 0);
    const empeoramiento = Math.max(
      0,
      ...tomas.toma2.filter((r) => r.roi !== 'general').map((r) => Math.abs(r.deltaT) - dt(tomas.toma1, r.roi)),
    );

    const grade = patient.gradoNeuropatia;
    const anios = clamp(patient.aniosEvolucionDm || 0, 0, 25);
    const dDedo = dt(tomas.toma2, 'dedo_mayor');
    const dMeta = dt(tomas.toma2, 'metatarso');
    const factores = [
      {
        key: 'tabaquismo',
        nombre: 'Tabaquismo',
        valor: patient.tabaquismo === null ? 'A consultar' : patient.tabaquismo ? 'Sí' : 'No',
        contribucion: COEF.tabaquismo * (patient.tabaquismo ? 1 : 0),
      },
      {
        key: 'insulinorequiriente',
        nombre: 'Insulinorequiriente',
        valor: patient.insulinorequiriente ? 'Sí' : 'No',
        contribucion: COEF.insulinorequiriente * (patient.insulinorequiriente ? 1 : 0),
      },
      {
        key: 'delta_dedo_mayor',
        nombre: 'ΔT Dedo mayor (toma 2)',
        valor: `${round(dDedo, 1)} °C`,
        contribucion: COEF.deltaDedoMayor * dDedo,
      },
      {
        key: 'evolucion',
        nombre: 'Aumento de asimetría entre tomas',
        valor: empeoramiento >= CAMBIO_SIGNIFICATIVO ? `+${round(empeoramiento, 1)} °C` : 'Estable o en mejora',
        contribucion: COEF.evolucion * (empeoramiento >= CAMBIO_SIGNIFICATIVO ? empeoramiento : 0),
      },
      { key: 'anios_dm', nombre: 'Años de DM', valor: `${round(anios, 1)} años`, contribucion: COEF.aniosDm * anios },
      {
        key: 'grado_neuropatia',
        nombre: 'Grado de neuropatía',
        valor: grade,
        contribucion: COEF.gradoNeuropatia * GRADE_INDEX[grade],
      },
      {
        key: 'delta_metatarso',
        nombre: 'ΔT Metatarso (toma 2)',
        valor: `${round(dMeta, 1)} °C`,
        contribucion: COEF.deltaMetatarso * dMeta,
      },
    ].map((f) => ({ ...f, contribucion: round(f.contribucion, 3) }));

    const logit = COEF.intercepto + factores.reduce((s, f) => s + f.contribucion, 0);
    const probabilidad = round(100 / (1 + Math.exp(-logit)), 1);

    return {
      predictorVersion: this.info.version,
      fuenteRois,
      rois: tomas.toma2,
      roisToma1: tomas.toma1,
      deltaTMax: s2.deltaTMax,
      deltaTMaxRoi: s2.deltaTMaxRoi,
      grupo: s2.grupo,
      simetrico: s2.simetrico,
      deltaTMaxToma1: s1.deltaTMax,
      deltaTMaxRoiToma1: s1.deltaTMaxRoi,
      grupoToma1: s1.grupo,
      simetricoToma1: s1.simetrico,
      umbral: this.umbral,
      probabilidad,
      categoria: categoryFor(probabilidad),
      horizonteSemanas: HORIZONTE_SEMANAS,
      factores: factores.sort((a, b) => b.contribucion - a.contribucion),
      simulado: true,
    };
  }
}

module.exports = MockUlcerPredictor;
module.exports.COEF = COEF;
