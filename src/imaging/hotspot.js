'use strict';

/**
 * Asimetría de ZONA CALIENTE CONTIGUA sobre la grilla canónica registrada.
 *
 * Es la variable que alimenta el riesgo de úlcera calibrado con la
 * bibliografía (src/services/predictors/literatureRisk.js). Los estudios de
 * monitoreo térmico comparan la temperatura de sitios homólogos de ambos pies
 * (6 puntos clave: hallux, cabezas de los metatarsianos 1, 3 y 5, mediopié y
 * talón) y alertan cuando la diferencia supera 2,2 °C (4 °F) en algún sitio
 * (Lavery et al. 2007, Diabetes Care 30:14-20, doi:10.2337/dc06-1600;
 * Frykberg et al. 2017, Diabetes Care 40:973-980, doi:10.2337/dc16-2294).
 *
 * El análisis punto a punto compara 4 000 celdas por pie en lugar de 6 sitios.
 * Para no reaccionar a un píxel aislado (y no inflar el máximo por comparar
 * miles de puntos), la diferencia se mide sólo en zonas CONTIGUAS:
 *  1. |ΔT| suavizado 3 × 3 (el mismo que da el «|ΔT| máx.» del portal);
 *  2. componentes conexas (4-vecinos) de celdas con |ΔT| ≥ umbral por punto y
 *     el MISMO pie más caliente;
 *  3. se conservan las componentes de al menos `areaMinPct` % de las celdas
 *     comparadas (y `minCeldas`): ≈ 2 cm² de planta, del orden de un sitio de
 *     medición (supuesto del portal, documentado);
 *  4. asimetría = mayor |ΔT| suavizado dentro de esas componentes.
 *
 * PERSISTENCIA entre tomas: los protocolos alertan cuando la diferencia supera
 * el umbral en DOS mediciones consecutivas (IWGDF 2023, recomendación 7). Con
 * dos tomas registradas en la misma grilla, el mapa persistente es, celda a
 * celda, el menor |ΔT| de ambas tomas cuando el mismo pie está más caliente en
 * las dos (0 si cambia de lado). Sobre ese mapa se repiten los pasos 2–4.
 */
const { GRID, zonaDeFila, diffGrid, smoothGrid } = require('./pointwise');

const AREA_MIN_PCT = 1;
const MIN_CELDAS = 20;

const valid = Number.isFinite;
const r2 = (v) => (valid(v) ? Math.round(v * 100) / 100 : null);

/** ΔT suavizado con las zonas no analizadas en NaN. */
function smoothedDelta(izq, der, zonasExcluidas = []) {
  const dt = diffGrid(izq, der);
  if (zonasExcluidas.length) {
    for (let r = 0; r < GRID.h; r += 1) {
      if (!zonasExcluidas.includes(zonaDeFila(r).key)) continue;
      for (let c = 0; c < GRID.w; c += 1) dt[r * GRID.w + c] = NaN;
    }
  }
  return smoothGrid(dt);
}

/**
 * Componentes contiguas de un mapa con signo (positivo = pie izquierdo más
 * caliente) y su mayor |valor|.
 */
function contiguousHot(map, { umbral = 1, areaMinPct = AREA_MIN_PCT, minCeldas = MIN_CELDAS } = {}) {
  let celdas = 0;
  for (const v of map) if (valid(v)) celdas += 1;
  if (!celdas) return null;
  const minimo = Math.max(minCeldas, Math.ceil((areaMinPct / 100) * celdas));
  const seen = new Uint8Array(map.length);
  const zonas = [];
  for (let i = 0; i < map.length; i += 1) {
    const v = map[i];
    if (seen[i] || !valid(v) || Math.abs(v) < umbral) continue;
    const signo = Math.sign(v);
    const stack = [i];
    seen[i] = 1;
    let n = 0;
    let max = 0;
    let at = i;
    while (stack.length) {
      const k = stack.pop();
      n += 1;
      if (Math.abs(map[k]) > max) {
        max = Math.abs(map[k]);
        at = k;
      }
      const r = Math.floor(k / GRID.w);
      const c = k % GRID.w;
      for (const [rr, cc] of [
        [r - 1, c],
        [r + 1, c],
        [r, c - 1],
        [r, c + 1],
      ]) {
        if (rr < 0 || cc < 0 || rr >= GRID.h || cc >= GRID.w) continue;
        const j = rr * GRID.w + cc;
        const w = map[j];
        if (seen[j] || !valid(w) || Math.abs(w) < umbral || Math.sign(w) !== signo) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (n >= minimo) zonas.push({ celdas: n, max, at, signo });
  }
  zonas.sort((a, b) => b.max - a.max);
  const top = zonas[0] || null;
  const fila = top ? Math.floor(top.at / GRID.w) : null;
  return {
    celdas,
    celdasMinimas: minimo,
    zonas: zonas.length,
    // Sin zona contigua sobre el umbral la asimetría queda por debajo del umbral.
    asimetria: top ? r2(top.max) : 0,
    areaPct: top ? Math.round((top.celdas / celdas) * 1000) / 10 : 0,
    zona: top ? zonaDeFila(fila).key : null,
    pieMasCaliente: top ? (top.signo > 0 ? 'izquierdo' : 'derecho') : null,
  };
}

/** Mapa persistente: menor |ΔT| de ambas tomas, sólo si el mismo pie está más caliente. */
function persistentMap(s1, s2) {
  const out = new Float32Array(s1.length).fill(NaN);
  for (let i = 0; i < s1.length; i += 1) {
    const a = s1[i];
    const b = s2[i];
    if (!valid(a) || !valid(b)) continue;
    out[i] = Math.sign(a) === Math.sign(b) ? Math.sign(a) * Math.min(Math.abs(a), Math.abs(b)) : 0;
  }
  return out;
}

/**
 * Hallazgo de zona caliente por toma y persistente entre tomas.
 * @param {Array<{toma:number, izq:Float32Array, der:Float32Array, zonasExcluidas?:string[]}>} tomas
 */
function hotspotFindings(tomas, opts = {}) {
  const maps = tomas.map((t) => ({ toma: t.toma, map: smoothedDelta(t.izq, t.der, t.zonasExcluidas || []) }));
  const porToma = maps.map((m) => ({ toma: m.toma, ...contiguousHot(m.map, opts) }));
  let persistente = null;
  if (maps.length >= 2) persistente = contiguousHot(persistentMap(maps[0].map, maps[1].map), opts);
  return { porToma, persistente, umbral: opts.umbral ?? 1, areaMinPct: opts.areaMinPct ?? AREA_MIN_PCT };
}

module.exports = { hotspotFindings, contiguousHot, persistentMap, smoothedDelta, AREA_MIN_PCT, MIN_CELDAS };
