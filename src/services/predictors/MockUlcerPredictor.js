'use strict';

const UlcerPredictor = require('./UlcerPredictor');
const { seededRandom, round } = require('../../utils/random');
const { ROIS, categoryFor, HORIZONTE_SEMANAS, DELTA_T_UMBRAL, thermalGroup } = require('../../config/domain');

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
  intercepto: -2.2,
  tabaquismo: 0.85,
  insulinorequiriente: 0.7,
  aniosDm: 0.04,
  gradoNeuropatia: 0.3,
  deltaDedoMayor: 0.5,
  deltaMetatarso: 0.4,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Estrategia simulada (`mock-v0`).
 *
 * Ignora el contenido de las imágenes y genera un resultado determinístico a
 * partir del código del paciente y la fecha del estudio: el mismo estudio
 * siempre produce el mismo resultado (reproducibilidad), y pacientes con más
 * factores de riesgo tienden a mostrar asimetrías térmicas mayores.
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
        'Genera temperaturas por ROI y una probabilidad verosímiles y determinísticas. No procesa las imágenes.',
    };
  }

  async predict({ patient, study }) {
    const seed = `${patient.codigo}|${String(study.fechaHora).slice(0, 10)}`;
    const rnd = seededRandom(seed);
    const noise = (amp) => (rnd() * 2 - 1) * amp;

    const grade = patient.gradoNeuropatia;
    const anios = clamp(patient.aniosEvolucionDm || 0, 0, 25);
    const riesgoClinico =
      (patient.tabaquismo ? 0.55 : 0) +
      (patient.insulinorequiriente ? 0.45 : 0) +
      anios * 0.025 +
      GRADE_INDEX[grade] * 0.3 +
      (patient.antecedenteUlcera ? 0.5 : 0);
    const severidad = clamp(riesgoClinico / 2.6 + noise(0.18), 0.05, 1);

    // Temperatura plantar media del paciente (influida levemente por el ambiente).
    const ambiente = Number.isFinite(study.tempAmbiente) && study.tempAmbiente !== null ? study.tempAmbiente : 22.5;
    const base = 28.4 + (ambiente - 22.5) * 0.4 + noise(1.6);

    // Región "caliente" y lado afectado.
    const hotspot = rnd() < 0.65 ? 'dedo_mayor' : 'metatarso';
    const lado = rnd() < 0.5 ? 1 : -1; // +1: pie derecho más caliente.
    const magnitud = Math.min(2.8, severidad * 2.45);

    const rois = [];
    for (const { key } of ROIS) {
      if (key === 'general') continue;
      const izq = clamp(base + ROI_OFFSET[key] + noise(0.35), 23, 33.5);
      let delta = noise(0.45);
      if (key === hotspot) delta = lado * clamp(magnitud + noise(0.15), 0, 2.8);
      else if ((key === 'metatarso' || key === 'dedo_mayor') && key !== hotspot)
        delta = lado * magnitud * 0.45 + noise(0.25);
      else if (key === 'dedos_menores') delta = lado * magnitud * 0.3 + noise(0.3);
      delta = clamp(delta, -2.8, 2.8);
      const der = clamp(izq + delta, 23, 34);
      rois.push(this.#roiRow(key, der, izq, rnd));
    }

    const mean = (k) => rois.reduce((s, r) => s + r[k], 0) / rois.length;
    const general = {
      roi: 'general',
      avgDer: round(mean('avgDer'), 2),
      avgIzq: round(mean('avgIzq'), 2),
      maxDer: round(Math.max(...rois.map((r) => r.maxDer)), 2),
      maxIzq: round(Math.max(...rois.map((r) => r.maxIzq)), 2),
      minDer: round(Math.min(...rois.map((r) => r.minDer)), 2),
      minIzq: round(Math.min(...rois.map((r) => r.minIzq)), 2),
    };
    general.deltaT = round(general.avgDer - general.avgIzq, 2);
    rois.push(general);

    const regionales = rois.filter((r) => r.roi !== 'general');
    const maxRow = regionales.reduce((m, r) => (Math.abs(r.deltaT) > Math.abs(m.deltaT) ? r : m));

    const dDedo = Math.abs(rois.find((r) => r.roi === 'dedo_mayor').deltaT);
    const dMeta = Math.abs(rois.find((r) => r.roi === 'metatarso').deltaT);

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
        nombre: 'ΔT Dedo mayor',
        valor: `${round(dDedo, 1)} °C`,
        contribucion: COEF.deltaDedoMayor * dDedo,
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
        nombre: 'ΔT Metatarso',
        valor: `${round(dMeta, 1)} °C`,
        contribucion: COEF.deltaMetatarso * dMeta,
      },
    ].map((f) => ({ ...f, contribucion: round(f.contribucion, 3) }));

    const logit = COEF.intercepto + factores.reduce((s, f) => s + f.contribucion, 0);
    const probabilidad = round(100 / (1 + Math.exp(-logit)), 1);

    const { grupo, simetrico } = thermalGroup(rois, this.umbral);

    return {
      predictorVersion: this.info.version,
      rois,
      deltaTMax: maxRow.deltaT,
      deltaTMaxRoi: maxRow.roi,
      umbral: this.umbral,
      grupo,
      simetrico,
      probabilidad,
      categoria: categoryFor(probabilidad),
      horizonteSemanas: HORIZONTE_SEMANAS,
      factores: factores.sort((a, b) => b.contribucion - a.contribucion),
      simulado: true,
    };
  }

  #roiRow(roi, der, izq, rnd) {
    const spread = () => 0.8 + rnd() * 0.8;
    return {
      roi,
      avgDer: round(der, 2),
      avgIzq: round(izq, 2),
      maxDer: round(der + spread(), 2),
      maxIzq: round(izq + spread(), 2),
      minDer: round(der - spread() - 0.2, 2),
      minIzq: round(izq - spread() - 0.2, 2),
      deltaT: round(der - izq, 2),
    };
  }
}

module.exports = MockUlcerPredictor;
module.exports.COEF = COEF;
