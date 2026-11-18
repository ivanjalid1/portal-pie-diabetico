'use strict';

/**
 * RIESGO DE ÚLCERA calibrado con la bibliografía (teorema de Bayes).
 *
 *   odds(posterior) = odds(prior) × LR(banda de asimetría)
 *
 * - PRIOR: incidencia de úlcera del grupo de riesgo IWGDF del paciente.
 * - LR: cociente de verosimilitud de la asimetría térmica contralateral
 *   (Frykberg 2017), por banda: < 2,2 °C, 2,2–3,2 °C y ≥ 3,2 °C.
 * - Se aplica UN solo LR por estudio (las bandas son excluyentes): no se
 *   multiplican LR que no son independientes (área caliente, |ΔT| máx., toma 1
 *   y toma 2 miden lo mismo). La persistencia entre tomas no suma un segundo
 *   LR (no hay uno publicado): acota el rango (ver `literatureRisk`).
 *
 * Todas las cifras se verificaron en la fuente (ver EVIDENCIA); ninguna se
 * estimó con los datos del portal. Documentación: docs/arquitectura.md §8.9.
 */

/** Fuentes verificadas. */
const EVIDENCIA = Object.freeze({
  frykberg2017: Object.freeze({
    cita: 'Frykberg RG, Gordon IL, Reyzelman AM, et al. Feasibility and Efficacy of a Smart Mat Technology to Predict Development of Diabetic Plantar Ulcers. Diabetes Care 2017;40(7):973-980',
    doi: '10.2337/dc16-2294',
    pagina: 'p. 973 (resumen)',
    // «At an asymmetry of 2.22°C […] the system correctly identified 97% of observed DFU, with an
    // average lead time of 37 days and a false-positive rate of 57%. Increasing the temperature
    // threshold to 3.20°C decreased sensitivity to 70% but similarly reduced the false-positive
    // rate to 32% […] lead time of 35 days.»
    umbrales: Object.freeze([
      Object.freeze({
        umbral: 2.2,
        umbralFuente: 2.22,
        sensibilidad: 0.97,
        falsosPositivos: 0.57,
        anticipacionDias: 37,
      }),
      Object.freeze({ umbral: 3.2, umbralFuente: 3.2, sensibilidad: 0.7, falsosPositivos: 0.32, anticipacionDias: 35 }),
    ]),
    // 129 participantes evaluables con úlcera previa (IWGDF 3); 37 (28,7 %) con 53 úlceras en 34 semanas.
    participantes: 129,
    conUlcera: 37,
    ulceras: 53,
    semanas: 34,
  }),
  lavery2019: Object.freeze({
    cita: 'Lavery LA, Petersen BJ, Linders DR, et al. Unilateral remote temperature monitoring to predict future ulceration for the diabetic foot in remission. BMJ Open Diabetes Res Care 2019;7(1):e000696',
    doi: '10.1136/bmjdrc-2019-000696',
    // Métodos: «Consistent with the approach employed previously with these data [Frykberg 2017],
    // we chose to report our false-positive and false-negative rates over a 2-month period»;
    // introducción: el método de 2,2 °C da «a specificity of 43%».
    pagina: 'Métodos («2-month period») e introducción (especificidad 43 %)',
    ventanaSemanas: 8.7,
  }),
  peters2001: Object.freeze({
    cita: 'Peters EJ, Lavery LA. Effectiveness of the diabetic foot risk classification system of the International Working Group on the Diabetic Foot. Diabetes Care 2001;24(8):1442-1447',
    doi: '10.2337/diacare.24.8.1442',
    pagina: 'p. 1442 (resumen)',
    // «During 3 years of follow-up, ulceration occurred in 5.1, 14.3, 18.8, and 55.8% of the
    // patients in groups 0, 1, 2, and 3, respectively.»
    ulceracion3Anios: Object.freeze([5.1, 14.3, 18.8, 55.8]),
    semanas: 156.43,
  }),
  iwgdf2023: Object.freeze({
    cita: 'Bus SA, Sacco ICN, Monteiro-Soares M, et al. Guidelines on the prevention of foot ulcers in persons with diabetes (IWGDF 2023 update). Diabetes Metab Res Rev 2024;40(3):e3651',
    doi: '10.1002/dmrr.3651',
    pagina:
      'Tabla 1 (estratificación 0–3) y recomendación 7 (2,2 °C en dos días consecutivos); pp. 12 y 4 de la versión de iwgdfguidelines.org',
  }),
});

const FRY = EVIDENCIA.frykberg2017;
/** Unidades de la sensibilidad y de la especificidad para el IC de Wilson (ver docs: supuesto conservador). */
const N_ULCERA = FRY.ulceras;
const N_SIN_ULCERA = FRY.participantes - FRY.conUlcera;

/** IC 95 % de Wilson de una proporción. */
function wilson(p, n, z = 1.96) {
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** LR de un estrato con fracción `a` de los que ulceran y `b` de los que no, con su rango. */
function stratumLr(a, b) {
  const [a0, a1] = wilson(a, N_ULCERA);
  const [b0, b1] = wilson(b, N_SIN_ULCERA);
  return { lr: a / b, rango: [a0 / b1, a1 / b0], fraccionUlcera: a, fraccionSinUlcera: b };
}

const MODOS = Object.freeze({
  graduado: 'Bandas < 2,2 / 2,2–3,2 / ≥ 3,2 °C',
  2.2: 'Un umbral: 2,2 °C',
  3.2: 'Un umbral: 3,2 °C',
});

/**
 * Bandas de asimetría con su LR (estratos excluyentes). Los LR de banda salen
 * de las sensibilidades y tasas de falsos positivos acumuladas de Frykberg 2017:
 * LR(2,2–3,2) = (0,97 − 0,70) / (0,57 − 0,32).
 */
function bandas(modo = 'graduado') {
  const [u22, u32] = FRY.umbrales;
  const s22 = u22.sensibilidad;
  const f22 = u22.falsosPositivos;
  const s32 = u32.sensibilidad;
  const f32 = u32.falsosPositivos;
  if (modo === '2.2') {
    return [
      { key: 'baja', nombre: '< 2,2 °C', desde: -Infinity, hasta: 2.2, ...stratumLr(1 - s22, 1 - f22) },
      { key: 'alta', nombre: '≥ 2,2 °C', desde: 2.2, hasta: Infinity, ...stratumLr(s22, f22) },
    ];
  }
  if (modo === '3.2') {
    return [
      { key: 'baja', nombre: '< 3,2 °C', desde: -Infinity, hasta: 3.2, ...stratumLr(1 - s32, 1 - f32) },
      { key: 'alta', nombre: '≥ 3,2 °C', desde: 3.2, hasta: Infinity, ...stratumLr(s32, f32) },
    ];
  }
  return [
    { key: 'baja', nombre: '< 2,2 °C', desde: -Infinity, hasta: 2.2, ...stratumLr(1 - s22, 1 - f22) },
    { key: 'media', nombre: '2,2–3,2 °C', desde: 2.2, hasta: 3.2, ...stratumLr(s22 - s32, f22 - f32) },
    { key: 'alta', nombre: '≥ 3,2 °C', desde: 3.2, hasta: Infinity, ...stratumLr(s32, f32) },
  ];
}

const bandaDe = (asimetria, bs) => bs.find((b) => asimetria >= b.desde && asimetria < b.hasta) || bs[0];

/**
 * Grupo de riesgo IWGDF con los datos de la planilla / ficha.
 * - LOPS: neuropatía registrada o percepción vibratoria alterada en algún pie.
 * - EAP: isquemia registrada.
 * - Antecedente: úlcera previa en algún pie (grupo 3, como en Peters 2001).
 * - Deformidad: no se registra; por eso el grupo 2 sólo surge de LOPS + EAP.
 * - Sin dato de neuropatía y sin otros factores: el grupo por defecto.
 */
function iwgdfGroup(patient, grupoDefecto = 1) {
  if (!patient) return { grupo: grupoDefecto, motivo: 'sin datos clínicos', porDefecto: true };
  const lops = Boolean(patient.neuropatia || patient.vibratoriaDerAlterada || patient.vibratoriaIzqAlterada);
  const pad = Boolean(patient.isquemia);
  const antecedente = Boolean(patient.ulceraPreviaDer || patient.ulceraPreviaIzq);
  if (antecedente) return { grupo: 3, motivo: 'antecedente de úlcera', porDefecto: false };
  if (lops && pad) return { grupo: 2, motivo: 'neuropatía y enfermedad arterial', porDefecto: false };
  if (lops) return { grupo: 1, motivo: 'neuropatía (pérdida de sensibilidad protectora)', porDefecto: false };
  if (pad) return { grupo: 1, motivo: 'enfermedad arterial periférica', porDefecto: false };
  if (patient.neuropatiaSinDato) return { grupo: grupoDefecto, motivo: 'sin dato de neuropatía', porDefecto: true };
  return { grupo: 0, motivo: 'sin neuropatía ni enfermedad arterial', porDefecto: false };
}

/** Incidencia acumulada de 3 años → horizonte (riesgo constante en el tiempo). */
function priorAt(pct3Anios, semanas) {
  const p = Math.min(0.999, Math.max(0, pct3Anios / 100));
  return 1 - (1 - p) ** (semanas / EVIDENCIA.peters2001.semanas);
}

const odds = (p) => p / (1 - p);
const prob = (o) => o / (1 + o);
/** Porcentaje con dos decimales (los riesgos de pocas semanas pueden ser < 1 %). */
const pct = (p) => Math.round(p * 10000) / 100;

/** Priors por grupo en el horizonte (fracción). */
function priorsAt(params) {
  const base = EVIDENCIA.peters2001.ulceracion3Anios;
  return [0, 1, 2, 3].map((g) => priorAt(params?.[`priorIwgdf${g}`] ?? base[g], params?.horizonteSemanas ?? 8));
}

/**
 * Categoría en la escala nueva: los cortes son los priors del propio horizonte
 * (moderado ≥ riesgo basal IWGDF 1; alto ≥ riesgo basal IWGDF 3).
 */
function cortesRiesgo(params) {
  const pr = priorsAt(params);
  return { moderado: pct(pr[1]), alto: pct(pr[3]) };
}

function categoriaRiesgo(probabilidad, cortes) {
  if (probabilidad >= cortes.alto) return 'alto';
  if (probabilidad >= cortes.moderado) return 'moderado';
  return 'sin_riesgo';
}

/**
 * @param {{asimetria:number, confirmada:number|null, tomas:number}} hallazgo
 *   asimetria: zona caliente contigua de la ÚLTIMA toma (estado actual);
 *   confirmada: la persistente entre toma 1 y toma 2 (null con una sola toma).
 * @param {object} patient
 * @param {object} params  horizonteSemanas, priorIwgdf0..3, grupoIwgdfDefecto, modoRiesgo,
 *   probNeuropatia (0–1, opcional: sólo se usa si falta el dato de neuropatía)
 *
 * Valor central: LR de la banda de la última toma. Rango: IC del LR; si la
 * banda no está confirmada por la otra toma (o hay una sola), el límite
 * inferior baja hasta el de la banda confirmada (con una sola toma, la banda
 * < umbral): en los estudios la alerta exige dos mediciones consecutivas.
 */
function literatureRisk(hallazgo, patient, params = {}) {
  const semanas = params.horizonteSemanas ?? 8;
  const modo = MODOS[params.modoRiesgo] ? params.modoRiesgo : 'graduado';
  const g = iwgdfGroup(patient, Number(params.grupoIwgdfDefecto ?? 1));
  const priors = priorsAt(params);
  let pr = priors[g.grupo];
  // Sin dato de neuropatía: si hay una probabilidad de neuropatía estimada por un
  // modelo entrenado con la cohorte (riskFactorCnn.js), el prior es la mezcla
  // p × prior(IWGDF 1) + (1 − p) × prior(IWGDF 0) en lugar del grupo por defecto.
  const pn = params.probNeuropatia;
  const estimado = g.porDefecto && Boolean(patient) && Number.isFinite(pn);
  if (estimado) pr = pn * priors[1] + (1 - pn) * priors[0];
  const bs = bandas(modo);
  const asimetria = hallazgo.asimetria ?? 0;
  const b = bandaDe(asimetria, bs);
  const conf = hallazgo.confirmada === null || hallazgo.confirmada === undefined ? null : hallazgo.confirmada;
  const bInf = conf === null ? bs[0] : bandaDe(Math.min(conf, asimetria), bs);
  const persistente = conf !== null && bInf.key === b.key;
  const post = (lr) => prob(odds(pr) * lr);
  const probabilidad = pct(post(b.lr));
  const rango = [pct(post(Math.min(bInf.rango[0], b.rango[0]))), pct(post(b.rango[1]))];
  const cortes = cortesRiesgo(params);
  return {
    version: 'riesgo-bibliografia-v1',
    probabilidad,
    rango,
    horizonteSemanas: semanas,
    grupoIwgdf: estimado ? (pn >= 0.5 ? 1 : 0) : g.grupo,
    grupoMotivo: estimado ? 'neuropatía estimada por el termograma' : g.motivo,
    grupoPorDefecto: estimado ? false : g.porDefecto,
    grupoEstimado: estimado ? { probNeuropatia: Math.round(pn * 1000) / 10 } : null,
    prior: pct(pr),
    asimetria,
    asimetriaConfirmada: conf,
    persistente,
    confirmable: conf !== null,
    tomas: hallazgo.tomas ?? 1,
    zona: hallazgo.zona ?? null,
    pieMasCaliente: hallazgo.pieMasCaliente ?? null,
    areaZonaPct: hallazgo.areaPct ?? null,
    modo,
    banda: { key: b.key, nombre: b.nombre },
    bandaConfirmada: { key: bInf.key, nombre: bInf.nombre },
    lr: Math.round(b.lr * 1000) / 1000,
    lrRango: b.rango.map((v) => Math.round(v * 1000) / 1000),
    cortes,
    categoria: categoriaRiesgo(probabilidad, cortes),
  };
}

module.exports = {
  EVIDENCIA,
  MODOS,
  wilson,
  bandas,
  iwgdfGroup,
  priorAt,
  priorsAt,
  cortesRiesgo,
  categoriaRiesgo,
  literatureRisk,
  N_ULCERA,
  N_SIN_ULCERA,
};
