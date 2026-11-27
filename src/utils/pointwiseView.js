'use strict';

/**
 * Ayudas de presentación del análisis punto a punto (las usan las vistas):
 * arma el JSON que dibuja public/js/pointwise.js y textos en lenguaje simple.
 */
const { decodeGrid, encodeGrid, zonaDeFila, GRID } = require('../imaging/pointwise');
const { shiftGrid, fueraDeProtocolo, AJUSTE_AMBIENTE } = require('../imaging/ambient');
const { zonasTexto, ZONA_NOMBRES } = require('../services/predictors/pointwiseAnalysis');
const thermal = require('./thermal');
const { fmt } = require('./format');
const { flagLabels } = require('../imaging/photoQuality');
const { observacionesVisibles } = require('./tesisExclusion');
const { fotoUsada } = require('../imaging/replicaChoice');

/** LUT High Contrast reducida a 64 colores (para el navegador). */
const LUT = (() => {
  const fn = thermal.PALETTES.alto_contraste.fn;
  return Array.from({ length: 64 }, (_, i) => fn(i / 63));
})();

function rangeOf(tomas) {
  const vals = [];
  for (const t of tomas) {
    for (const g of [t.izq, t.der]) for (const v of decodeGrid(g)) if (Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return { lo: 24, hi: 35 };
  vals.sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
  return { lo: Math.round(q(0.02) * 10) / 10, hi: Math.round(q(0.98) * 10) / 10 };
}

/**
 * Grillas de una toma con las temperaturas absolutas ajustadas por el ambiente
 * de la sala (src/imaging/ambient.js). Las diferencias izq. − der. y el cambio
 * respecto de la mediana de cada pie no se alteran: el ajuste es una constante.
 */
function gridsAjustadas(t) {
  const d = t.ambiente?.ajusteC;
  if (!d) return { izq: t.izq, der: t.der };
  return { izq: encodeGrid(shiftGrid(decodeGrid(t.izq), d)), der: encodeGrid(shiftGrid(decodeGrid(t.der), d)) };
}

/** ¿Alguna toma con temperaturas absolutas ajustadas por ambiente? */
const conAjusteAmbiente = (a) => Boolean(a?.puntual?.tomas?.some((t) => t.ambiente?.ajusteC));

/** Datos mínimos para dibujar los mapas (grillas, zonas excluidas, métricas, umbrales, LUT). */
function payload(a) {
  const p = a?.puntual;
  if (!p) return null;
  const tomas = p.tomas.map((t) => ({ ...t, ...gridsAjustadas(t) }));
  return {
    grilla: p.grilla,
    umbralPixel: p.umbralPixel,
    umbralCambio: p.umbralCambio,
    rango: rangeOf(tomas),
    lut: LUT,
    tomas: tomas.map((t) => ({
      toma: t.toma,
      izq: t.izq,
      der: t.der,
      zonasNoAnalizadas: t.zonasNoAnalizadas,
      metricas: t.metricas ? { hotspot: t.metricas.hotspot } : null,
      tci: t.tci?.mapas ? { mapas: t.tci.mapas } : null,
    })),
  };
}

/**
 * Condiciones de la sala de una toma, para mostrar:
 * «Sala 22,1 °C · HR 55 % (medida)» o «Sala ≈21,5 °C (estimada)».
 * `rangos` = protocolo vigente (Configuración).
 */
function ambienteToma(amb, rangos = null) {
  if (!amb || (amb.tempC === null && amb.humedad === null)) {
    return { texto: 'Sin registro de la sala', origen: null, fuera: { temp: false, hum: false, alguno: false } };
  }
  const est = amb.origen === 'estimada';
  const partes = [];
  if (amb.tempC !== null) partes.push(`Sala ${est ? '≈' : ''}${fmt.num(amb.tempC, 1)} °C`);
  if (amb.humedad !== null) partes.push(`HR ${fmt.num(amb.humedad, 0)} %`);
  return {
    texto: partes.join(' · '),
    origen: est ? 'estimada' : 'medida',
    detalle: est
      ? `Estimada por el fondo del termograma (±${fmt.num(amb.errorC ?? 0.7, 1)} °C); no se registró en la planilla.`
      : 'Registrada en la planilla del equipo.',
    ajusteC: amb.ajusteC ?? null,
    fuera: fueraDeProtocolo(amb, rangos),
  };
}

/**
 * Ambiente de cada toma de un estudio: el del análisis (medido o estimado) o,
 * si no lo trae, el registrado en el estudio.
 */
function ambientesDe(a, study) {
  const out = {};
  for (const k of [1, 2]) {
    const t = a?.puntual?.tomas?.find((x) => x.toma === k);
    if (t?.ambiente) out[k] = t.ambiente;
    else if (study) {
      const tempC = k === 1 ? study.tempAmbienteToma1 : study.tempAmbiente;
      const humedad = k === 1 ? study.humedadRelativaToma1 : study.humedadRelativa;
      if (tempC !== null || humedad !== null) out[k] = { tempC, humedad, origen: 'medida', ajusteC: null };
    }
  }
  return out;
}

/** JSON seguro para incrustar en <script type="application/json">. */
const json = (obj) => JSON.stringify(obj).replace(/</g, '\u003c');

const LADO = { medial: 'interno', lateral: 'externo' };

/** «metatarso (lado interno) del pie izquierdo» */
function hotspotTexto(m) {
  if (!m?.hotspot) return '';
  const h = m.hotspot;
  return `${ZONA_NOMBRES[h.zona]} (lado ${LADO[h.lado]}), más caliente el pie ${h.pieMasCaliente}`;
}

/** «los dedos», «el metatarso»… (para frases en lenguaje simple). */
const ZONA_CON_ARTICULO = Object.freeze({
  dedos: 'los dedos',
  metatarso: 'el metatarso',
  arco: 'el arco',
  talon: 'el talón',
});

const pct1 = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const numEs = (v, dec = 0) => fmt.num(v, dec);

/**
 * Lectura en lenguaje simple de una toma: qué parte de la planta difiere más
 * que el umbral, qué pie está más caliente y en qué zona se concentra.
 * Se calcula sobre la misma grilla y las mismas zonas excluidas que las métricas.
 */
function lecturaToma(t, umbral) {
  if (!t?.metricas || !t.izq || !t.der) return null;
  const izq = decodeGrid(t.izq);
  const der = decodeGrid(t.der);
  const excl = t.zonasNoAnalizadas || [];
  const porZona = {};
  let n = 0;
  let calIzq = 0;
  let calDer = 0;
  for (let i = 0; i < izq.length; i += 1) {
    const zona = zonaDeFila(Math.floor(i / GRID.w)).key;
    if (excl.includes(zona) || !Number.isFinite(izq[i]) || !Number.isFinite(der[i])) continue;
    n += 1;
    const d = izq[i] - der[i];
    if (Math.abs(d) <= umbral) continue;
    const z = (porZona[zona] ||= { izq: 0, der: 0 });
    if (d > 0) {
      calIzq += 1;
      z.izq += 1;
    } else {
      calDer += 1;
      z.der += 1;
    }
  }
  const pct = t.metricas.areaCalientePct;
  const pctIzq = pct1(calIzq, n);
  const pctDer = pct1(calDer, n);
  const pie = calIzq >= 2 * calDer && calIzq > 0 ? 'izquierdo' : calDer >= 2 * calIzq && calDer > 0 ? 'derecho' : null;
  const cuenta = (z) => (pie === 'izquierdo' ? z.izq : pie === 'derecho' ? z.der : z.izq + z.der);
  const total = Object.values(porZona).reduce((s, z) => s + cuenta(z), 0);
  const [zonaTop, zTop] = Object.entries(porZona).sort((a, b) => cuenta(b[1]) - cuenta(a[1]))[0] || [null, null];
  const zona = zTop && total && cuenta(zTop) / total >= 0.45 ? zonaTop : null;
  const u = numEs(umbral, 1);
  const donde = zona ? `, sobre todo en ${ZONA_CON_ARTICULO[zona]}` : ', repartido en varias zonas';
  let frase;
  if (pct < 1) {
    frase = `Los dos pies tienen temperaturas parecidas: menos del 1 % de la planta difiere más de ${u} °C.`;
  } else if (pie) {
    const otro = pie === 'izquierdo' ? 'derecho' : 'izquierdo';
    const p = pie === 'izquierdo' ? pctIzq : pctDer;
    frase = `El ${numEs(p, 0)} % de la planta del pie ${pie} está más de ${u} °C más caliente que el ${otro}${donde}.`;
  } else {
    frase = `El ${numEs(pct, 0)} % de la planta difiere más de ${u} °C entre los pies (${numEs(pctIzq, 0)} % más caliente el izquierdo y ${numEs(pctDer, 0)} % el derecho)${donde}.`;
  }
  return { pct, pctIzq, pctDer, pie, zona, frase };
}

/** «no se analizaron los dedos», «no se analizó el talón» (o null si se analizó todo). */
function noAnalizadoTexto(t) {
  const zs = t?.zonasNoAnalizadas || [];
  if (!zs.length) return null;
  const l = zs.map((k) => ZONA_CON_ARTICULO[k]);
  const txt = l.length > 1 ? `${l.slice(0, -1).join(', ')} y ${l.at(-1)}` : l[0];
  return `no se ${zs.length > 1 || zs[0] === 'dedos' ? 'analizaron' : 'analizó'} ${txt}`;
}

/**
 * Aviso de calidad baja de las fotos de una toma (banderas automáticas del
 * precálculo): null si alguna réplica está limpia o no hay datos.
 * @returns {null|{texto: string, avisos: string[], replicas: number}}
 */
function calidadFotosAviso(t) {
  const q = t?.calidadFotos;
  if (!q || !q.baja) return null;
  const avisos = flagLabels(q.banderas)
    .filter((f) => f.grave)
    .map((f) => f.label);
  const n = q.replicas || 0;
  const lista = avisos.join(', ').toLowerCase();
  // Con alguna foto limpia en la toma, la usada (elegida a mano) es la que tiene problemas.
  const texto =
    q.limpias > 0 && q.elegidaPor
      ? `la foto elegida tiene problemas (${lista}); hay ${q.limpias === 1 ? 'otra foto' : 'otras fotos'} de la toma sin avisos graves`
      : `ninguna de las ${n} foto${n === 1 ? '' : 's'} está libre de problemas; se usó la menos afectada (${lista})`;
  return { avisos, replicas: n, texto };
}

/** Cambio del área con diferencia entre la toma 1 y la toma 2 (puntos porcentuales). */
function cambioArea(a) {
  const m1 = a?.puntualToma?.(1)?.metricas;
  const m2 = a?.puntualToma?.(2)?.metricas;
  if (!m1 || !m2) return null;
  const d = Math.round((m2.areaCalientePct - m1.areaCalientePct) * 10) / 10;
  const sentido = Math.abs(d) < 2 ? 'se mantuvo' : d > 0 ? 'aumentó' : 'disminuyó';
  return {
    delta: d,
    sentido,
    frase: `Respecto de la toma 1, el área con diferencia ${sentido} (${numEs(m1.areaCalientePct, 0)} % → ${numEs(m2.areaCalientePct, 0)} %).`,
  };
}

/* ---------------- Pronóstico por zona ---------------- */

/**
 * Una línea en lenguaje simple para el paciente sobre el próximo control, a
 * partir de la zona con mayor área caliente esperada (ThermalForecastService).
 * No anticipa mejoras ni empeoramientos: el modelo es sobre todo regresión a la
 * media (docs/arquitectura.md §8.11); sólo dice qué se va a volver a mirar.
 */
function pronosticoFrase(fc) {
  const w = fc?.disponible ? fc.peor : null;
  if (!w) return null;
  const pie = w.pie === 'izq' ? 'izquierdo' : 'derecho';
  const donde = `en ${ZONA_CON_ARTICULO[w.zona]} del pie ${pie}`;
  if (w.esperado < (fc.areaUmbral ?? 10) && w.actual < (fc.areaUmbral ?? 10)) {
    return 'En tu próximo control vamos a volver a comparar la temperatura de tus dos pies.';
  }
  return `En tu próximo control vamos a volver a comparar la temperatura de tus pies, sobre todo ${donde}.`;
}

/* ---------------- Riesgo de úlcera ---------------- */

/** Número de un porcentaje de riesgo (los de pocas semanas suelen ser < 1 %). */
function riesgoNum(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  if (n > 0 && n < 0.1) return '< 0,1';
  return fmt.num(n, n < 10 ? 1 : 0);
}

/** «0,8 %» */
const riesgoPct = (v) => `${riesgoNum(v)} %`;

/** «0,4–1,8 %» */
function riesgoRango(r) {
  if (!r || r.length !== 2) return '';
  const lo = riesgoNum(r[0]);
  return `${lo === '< 0,1' ? '0' : lo}–${riesgoNum(r[1])} %`;
}

/** Horizonte en lenguaje simple: «8 semanas», «2 meses», «12 meses». */
function horizonteTexto(semanas) {
  const s = Number(semanas);
  if (!Number.isFinite(s)) return '';
  // 52 semanas = 12 meses (y 26 = 6, 104 = 24); por debajo de 6 meses, 4 semanas ≈ 1 mes.
  if (s >= 26 && (s * 12) % 52 === 0) return `${(s * 12) / 52} meses`;
  if (s % 4 === 0 && s >= 8 && s < 26) return `${s / 4} meses`;
  return `${s} semanas`;
}

/** «los próximos 2 meses» / «las próximas 6 semanas». */
function horizonteFrase(semanas) {
  const t = horizonteTexto(semanas);
  return t.endsWith('meses') ? `los próximos ${t}` : `las próximas ${t}`;
}

/** Riesgo que muestra la interfaz (modelo entrenado si lo hay; si no, el bibliográfico). */
function riesgoDe(a) {
  const P = a && a.puntual;
  if (!P) return null;
  if (P.riesgoEntrenado) {
    return {
      fuente: 'modelo',
      probabilidad: P.riesgoEntrenado.probabilidad,
      rango: null,
      horizonteSemanas: P.riesgo ? P.riesgo.horizonteSemanas : a.horizonteSemanas,
      grupoIwgdf: P.riesgo ? P.riesgo.grupoIwgdf : null,
      bib: P.riesgo || null,
      modelo: P.riesgoEntrenado,
    };
  }
  if (!P.riesgo) return null;
  return { fuente: 'bibliografia', ...P.riesgo, bib: P.riesgo, modelo: null };
}

const TOOLTIP_RIESGO =
  'Estimado a partir de la asimetría térmica punto a punto y la evidencia publicada (Frykberg 2017; Peters y Lavery 2001; IWGDF 2023). Los cocientes de verosimilitud valen por períodos de 2 meses: el riesgo a 12 meses los compone suponiendo que la asimetría se mantiene, y el rango incluye el caso en que no. Se reemplazará por un modelo entrenado con los desenlaces del portal cuando haya ≥10 lesiones registradas.';

module.exports = {
  pronosticoFrase,
  riesgoNum,
  riesgoPct,
  riesgoRango,
  horizonteTexto,
  horizonteFrase,
  riesgoDe,
  TOOLTIP_RIESGO,
  payload,
  json,
  ambienteToma,
  ambientesDe,
  conAjusteAmbiente,
  AJUSTE_AMBIENTE,
  zonasTexto,
  hotspotTexto,
  lecturaToma,
  noAnalizadoTexto,
  calidadFotosAviso,
  fotoUsada,
  observacionesVisibles,
  cambioArea,
  ZONA_NOMBRES,
  ZONA_CON_ARTICULO,
  LUT,
  rangeOf,
};
