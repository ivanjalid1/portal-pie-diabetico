'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { encodePng } = require('../imaging/png');
const { highContrast } = require('../utils/thermal');
const { readNpy, writeNpy } = require('../utils/npy');
const { AppError } = require('../utils/errors');

/**
 * Corrección manual de máscaras de segmentación (herramienta SÓLO LOCAL).
 *
 * Fuente: las réplicas exportadas para la U-Net (scripts/ml/export-seg-data.js)
 * en data-local/ml/cache/ (temperatura `<clave>_t.npy`, segmentación clásica
 * `<clave>_cls.npy`, índice `index.json`) y las máscaras de la U-Net
 * (data-local/ml/unet-masks/<clave>.npy). El médico o el administrador
 * corrige la máscara con pincel y goma; se guarda en
 * data-local/ml/corrected-masks/<clave>.npy (uint8 240 × 320: 0 fondo, 1 pie a
 * la izquierda de la imagen, 2 a la derecha), con un .json de metadatos (quién
 * —sólo rol e id interno— y cuándo). Esas máscaras son contornos
 * independientes para evaluar la U-Net (scripts/ml/dice_corrected.py) y para
 * reentrenarla.
 *
 * Las claves son hashes de la ruta del archivo: nunca se muestran nombres.
 */
const KEY_RE = /^[0-9a-f]{16}$/;
const W = 320;
const H = 240;

/** Etiquetas (Uint8Array) → RLE compacto «valor:cantidad,…». */
function encodeRle(labels) {
  const out = [];
  let v = labels[0];
  let n = 0;
  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i] === v) n += 1;
    else {
      out.push(`${v}:${n}`);
      v = labels[i];
      n = 1;
    }
  }
  out.push(`${v}:${n}`);
  return out.join(',');
}

/** RLE → etiquetas; valida longitud total y valores 0–2. */
function decodeRle(rle, total = W * H) {
  if (typeof rle !== 'string' || rle.length > 200000 || !/^[0-2]:\d+(,[0-2]:\d+)*$/.test(rle)) {
    throw new AppError('Máscara inválida.', 400, 'mask_invalid');
  }
  const out = new Uint8Array(total);
  let i = 0;
  for (const part of rle.split(',')) {
    const [v, n] = part.split(':').map(Number);
    if (i + n > total) throw new AppError('Máscara inválida (tamaño).', 400, 'mask_invalid');
    out.fill(v, i, i + n);
    i += n;
  }
  if (i !== total) throw new AppError('Máscara inválida (tamaño).', 400, 'mask_invalid');
  return out;
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

class MaskService {
  /** @param {{dir: string|null}} opts carpeta data-local (null = deshabilitada) */
  constructor({ dir }) {
    this.dir = dir;
    this.cache = dir ? path.join(dir, 'ml', 'cache') : null;
    this.unet = dir ? path.join(dir, 'ml', 'unet-masks') : null;
    this.corrected = dir ? path.join(dir, 'ml', 'corrected-masks') : null;
  }

  get enabled() {
    return Boolean(this.cache && fs.existsSync(path.join(this.cache, 'index.json')));
  }

  index() {
    if (!this.enabled) return [];
    if (!this._index) {
      const raw = JSON.parse(fs.readFileSync(path.join(this.cache, 'index.json'), 'utf8'));
      this._index = raw.filter((e) => e.exportado && KEY_RE.test(e.key));
    }
    return this._index;
  }

  entry(key) {
    if (!KEY_RE.test(String(key))) throw new AppError('Imagen no encontrada.', 404, 'not_found');
    const e = this.index().find((x) => x.key === key);
    if (!e) throw new AppError('Imagen no encontrada.', 404, 'not_found');
    return e;
  }

  isCorrected(key) {
    return fs.existsSync(path.join(this.corrected, `${key}.npy`));
  }

  /**
   * Listado: primero las de menor calidad de la segmentación clásica (las más
   * probables de estar mal), con filtro opcional.
   * @param {{filtro?: 'todas'|'pendientes'|'corregidas', page?: number, perPage?: number}} q
   */
  list({ filtro = 'pendientes', page = 1, perPage = 40 } = {}) {
    const all = this.index().map((e) => ({
      key: e.key,
      codigo: e.codigo,
      toma: e.toma,
      replica: e.rep + 1,
      calidad: e.calidad ?? null,
      noValido: Boolean(e.noValido),
      unet: fs.existsSync(path.join(this.unet, `${e.key}.npy`)),
      corregida: this.isCorrected(e.key),
    }));
    const corregidas = all.filter((e) => e.corregida).length;
    let items = all;
    if (filtro === 'pendientes') items = all.filter((e) => !e.corregida);
    else if (filtro === 'corregidas') items = all.filter((e) => e.corregida);
    items.sort((a, b) => (a.calidad ?? -1) - (b.calidad ?? -1) || a.codigo.localeCompare(b.codigo));
    const pages = Math.max(1, Math.ceil(items.length / perPage));
    const p = Math.min(Math.max(1, page), pages);
    return {
      total: all.length,
      corregidas,
      filtro,
      page: p,
      pages,
      items: items.slice((p - 1) * perPage, p * perPage),
      filtrados: items.length,
    };
  }

  temperature(key) {
    this.entry(key);
    const t = readNpy(path.join(this.cache, `${key}_t.npy`));
    if (t.shape[0] !== H || t.shape[1] !== W) throw new AppError('Tamaño de imagen no soportado.', 400, 'mask_size');
    return t.data;
  }

  /**
   * Termograma (PNG 320 × 240, sólo la matriz IR). `grises` (por defecto en el
   * editor: el contorno de color se distingue mejor) o High Contrast.
   */
  imagePng(key, { paleta = 'alto_contraste' } = {}) {
    const T = this.temperature(key);
    const vals = Float32Array.from(T).sort();
    const lo = percentile(vals, 0.02);
    const hi = Math.max(lo + 0.5, percentile(vals, 0.997));
    const gris = (t) => {
      const v = Math.round(Math.max(0, Math.min(1, t)) * 255);
      return [v, v, v];
    };
    const color = paleta === 'grises' ? gris : highContrast;
    const rgb = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i += 1) {
      const [r, g, b] = color((T[i] - lo) / (hi - lo));
      rgb[i * 3] = r;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = b;
    }
    return encodePng(W, H, rgb);
  }

  readLabels(file) {
    if (!fs.existsSync(file)) return null;
    const m = readNpy(file);
    return m.data.length === W * H ? Uint8Array.from(m.data) : null;
  }

  /** Máscaras disponibles de una réplica (RLE) y cuál se edita por defecto. */
  masks(key) {
    const e = this.entry(key);
    const corr = this.readLabels(path.join(this.corrected, `${key}.npy`));
    const unet = this.readLabels(path.join(this.unet, `${key}.npy`));
    const cls = this.readLabels(path.join(this.cache, `${key}_cls.npy`));
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(this.corrected, `${key}.json`), 'utf8'));
    } catch {
      meta = null;
    }
    const base = corr ? 'corregida' : unet ? 'unet' : 'clasica';
    return {
      key,
      codigo: e.codigo,
      toma: e.toma,
      replica: e.rep + 1,
      width: W,
      height: H,
      base,
      corregida: corr ? encodeRle(corr) : null,
      unet: unet ? encodeRle(unet) : null,
      clasica: cls ? encodeRle(cls) : null,
      guardada: meta ? meta.fecha : null,
    };
  }

  /** Guarda la máscara corregida (RLE) y sus metadatos. */
  save(key, rle, actor, { origen = null } = {}) {
    this.entry(key);
    const labels = decodeRle(rle);
    const pix = [0, 0, 0];
    for (const v of labels) pix[v] += 1;
    if (pix[1] < 50 || pix[2] < 50) {
      throw new AppError('Cada pie debe tener al menos 50 píxeles marcados.', 400, 'mask_small');
    }
    fs.mkdirSync(this.corrected, { recursive: true });
    writeNpy(path.join(this.corrected, `${key}.npy`), labels, [H, W]);
    const meta = {
      key,
      fecha: new Date().toISOString(),
      rol: actor?.role || null,
      usuario: actor?.id || null,
      partiDe: ['unet', 'clasica', 'corregida'].includes(origen) ? origen : null,
      pixeles: { fondo: pix[0], pieIzquierdoImagen: pix[1], pieDerechoImagen: pix[2] },
    };
    fs.writeFileSync(path.join(this.corrected, `${key}.json`), JSON.stringify(meta, null, 2));
    return meta;
  }
}

module.exports = { MaskService, encodeRle, decodeRle, KEY_RE };
