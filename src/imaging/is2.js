'use strict';

/**
 * Decodificador del archivo .IS2 de Fluke (cámaras Ti/TiS).
 *
 * El .IS2 es un ZIP. La imagen infrarroja está en `Images/Main/IR.data`: una
 * matriz de 320 × 241 valores uint16 little-endian, cuya primera fila (640
 * bytes) es una cabecera. Los valores son cuentas crudas del sensor (sin
 * calibrar a °C): sirven para la visualización relativa y la comparación
 * izquierda/derecha, pero la temperatura absoluta requiere los parámetros de
 * calibración del equipo.
 *
 * El análisis usa sólo la matriz IR. La foto visible (`Images/Main/028001E0.jpg`,
 * 640 × 480; el nombre codifica ancho y alto en hexadecimal) se extrae ÚNICAMENTE
 * para el visor local con datos reales (`extractVisible`): puede mostrar caras,
 * el entorno o documentos, así que nunca se guarda en public/, nunca se
 * versiona y nunca se despliega. Las miniaturas tienen texto impreso (fecha,
 * hora, equipo) y no se muestran.
 *
 * Registro IR → visible (IR-Fusion): `Images/Main/VLImageInfo.gpbenc` es
 * idéntico en todos los archivos de la TiS75 del estudio y ubica el campo IR
 * en (160, 120) con tamaño 960 × 720 sobre el sensor visible de 1280 × 960.
 * En la foto de 640 × 480: el píxel IR (x, y) cae en (80 + 1,5·x, 60 + 1,5·y),
 * es decir, el recorte central de 480 × 360 (75 %). No hay corrección de
 * paralaje por archivo; el desvío residual medido es de 2–4 px visibles.
 */
const { readZip } = require('./zip');

const WIDTH = 320;
const HEIGHT = 240;
const HEADER_BYTES = WIDTH * 2;

/** @returns {{ width: number, height: number, data: Uint16Array }} */
function decodeIs2(buffer) {
  const zip = readZip(buffer);
  const key = [...zip.keys()].find((k) => /(^|\/)Images\/Main\/IR\.data$/i.test(k));
  if (!key) throw new Error('El archivo IS2 no contiene Images/Main/IR.data');
  const raw = zip.get(key)();
  const expected = HEADER_BYTES + WIDTH * HEIGHT * 2;
  if (raw.length < expected) throw new Error(`IR.data con tamaño inesperado (${raw.length} B)`);
  const data = new Uint16Array(WIDTH * HEIGHT);
  for (let i = 0; i < data.length; i += 1) data[i] = raw.readUInt16LE(HEADER_BYTES + i * 2);
  return { width: WIDTH, height: HEIGHT, data };
}

/** Registro fijo IR → foto visible de la TiS75 (ver cabecera). */
const FUSION = Object.freeze({ vlWidth: 640, vlHeight: 480, x: 80, y: 60, scale: 1.5 });
const VISIBLE_RE = /(^|\/)Images\/Main\/028001E0\.jpe?g$/i;

/**
 * Foto visible completa (640 × 480, JPEG re-codificado: sin EXIF ni otros
 * metadatos). El campo IR ocupa el rectángulo `FUSION` dentro de ella.
 * Devuelve null si el archivo no trae foto o tiene otro tamaño.
 * @returns {{ jpeg: Buffer, width: number, height: number }|null}
 */
function extractVisible(buffer, { quality = 84 } = {}) {
  const jpeg = require('jpeg-js');
  const zip = readZip(buffer);
  const key = [...zip.keys()].find((k) => VISIBLE_RE.test(k));
  if (!key) return null;
  let img;
  try {
    img = jpeg.decode(zip.get(key)(), { useTArray: true, maxMemoryUsageInMB: 64 });
  } catch {
    return null;
  }
  if (img.width !== FUSION.vlWidth || img.height < FUSION.vlHeight) return null;
  const { vlWidth: w, vlHeight: h } = FUSION;
  const data = Buffer.from(img.data.buffer, img.data.byteOffset, w * h * 4);
  return { jpeg: Buffer.from(jpeg.encode({ data, width: w, height: h }, quality).data), width: w, height: h };
}

/** ¿El IS2 trae foto visible? (sin decodificarla) */
const hasVisible = (buffer) => [...readZip(buffer).keys()].some((k) => VISIBLE_RE.test(k));

/** Decodificador protobuf genérico (sólo lo necesario para los .gpbenc de Fluke). */
function parseGpb(buf) {
  const out = new Map();
  let p = 0;
  const varint = () => {
    let v = 0;
    let m = 1;
    let c;
    do {
      c = buf[p];
      p += 1;
      v += (c & 127) * m;
      m *= 128;
    } while (c & 128 && p < buf.length);
    return v;
  };
  const push = (f, v) => out.set(f, [...(out.get(f) || []), v]);
  while (p < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const type = key % 8;
    if (type === 0) push(field, varint());
    else if (type === 5) {
      push(field, buf.readFloatLE(p));
      p += 4;
    } else if (type === 1) {
      push(field, buf.readDoubleLE(p));
      p += 8;
    } else if (type === 2) {
      const len = varint();
      push(field, buf.subarray(p, p + len));
      p += len;
    } else throw new Error(`gpb: tipo ${type} no soportado`);
  }
  return out;
}

/**
 * Metadatos de captura NO identificatorios del IS2 (pestaña «Información» del
 * visor): modelo de cámara (sin número de serie), parámetros radiométricos y
 * escala configurada en la cámara. Campos faltantes quedan en null.
 */
function is2Info(buffer) {
  const zip = readZip(buffer);
  const get = (re) => {
    const k = [...zip.keys()].find((x) => re.test(x));
    try {
      return k ? parseGpb(zip.get(k)()) : null;
    } catch {
      return null;
    }
  };
  const first = (m, f) => (m && m.has(f) ? m.get(f)[0] : null);
  const r2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  const ir = get(/Images\/Main\/IRImageInfo\.gpbenc$/i);
  const cam = get(/(^|\/)CameraInfo\.gpbenc$/i);
  let escala = null;
  const sub = first(ir, 14);
  if (Buffer.isBuffer(sub)) {
    try {
      const m = parseGpb(sub);
      const lo = r2(first(m, 6));
      const hi = r2(first(m, 7));
      if (lo !== null && hi !== null && hi > lo) escala = { min: lo, max: hi };
    } catch {
      // sin escala
    }
  }
  // Sólo el modelo (p. ej. «TiS75»): el número de serie del equipo no se muestra.
  const modeloRaw = first(cam, 23);
  const modelo = Buffer.isBuffer(modeloRaw) ? /^[A-Za-z]+\d*/.exec(modeloRaw.toString('latin1'))?.[0] || null : null;
  const transm = r2(first(ir, 12));
  return {
    camara: modelo ? `Fluke ${modelo}` : null,
    emisividad: r2(first(ir, 10)),
    fondoC: r2(first(ir, 11)),
    transmision: transm !== null ? Math.round(transm * 100) : null,
    escalaCamara: escala,
    ir: { width: WIDTH, height: HEIGHT },
    visible: hasVisible(buffer) ? { width: FUSION.vlWidth, height: FUSION.vlHeight } : null,
  };
}

/** Percentil de un arreglo numérico (copia ordenada). */
function percentile(values, p) {
  const sorted = Float64Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

module.exports = { decodeIs2, extractVisible, hasVisible, is2Info, parseGpb, percentile, FUSION, WIDTH, HEIGHT };
