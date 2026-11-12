'use strict';

const { ACCEPTED_IMAGE_TYPES, IMAGE_SLOTS } = require('../config/domain');

/**
 * Detecta el tipo real de un archivo por su firma ("magic bytes"), sin confiar
 * en la extensión ni en el `Content-Type` declarado por el navegador.
 *
 * El formato .IS2 de Fluke es un contenedor ZIP (firma `PK\x03\x04`); se
 * acepta sólo si además la extensión es .is2, para no admitir ZIP arbitrarios.
 */
function sniffImageType(buffer, originalName = '') {
  if (!buffer || buffer.length < 4) return null;
  const b = buffer;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  const tiffLE = b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00;
  const tiffBE = b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a;
  if (tiffLE || tiffBE) return 'image/tiff';
  const zip = b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  if (zip && /\.is2$/i.test(String(originalName))) return 'application/x-fluke-is2';
  return null;
}

/**
 * Valida que estén las dos imágenes requeridas y que sean JPG, PNG, TIFF o IS2.
 * @param {Record<string, {buffer: Buffer, originalname: string, size: number}>} filesBySlot
 * @returns {{ok: boolean, errors: Record<string,string>, images: Array}}
 */
function validateStudyImages(filesBySlot, maxBytes, slots = IMAGE_SLOTS.map((s) => s.slot)) {
  const errors = {};
  const images = [];
  for (const { slot, corto } of IMAGE_SLOTS.filter((s) => slots.includes(s.slot))) {
    const file = filesBySlot?.[slot];
    if (!file || !file.buffer?.length) {
      errors[slot] = `Falta cargar la ${corto}.`;
      continue;
    }
    if (maxBytes && file.size > maxBytes) {
      errors[slot] = 'El archivo supera el tamaño máximo permitido.';
      continue;
    }
    const mime = sniffImageType(file.buffer, file.originalname);
    if (!mime || !ACCEPTED_IMAGE_TYPES[mime]) {
      errors[slot] = 'Formato no admitido. Usá JPG, PNG, TIFF o IS2 (Fluke).';
      continue;
    }
    const ext = ACCEPTED_IMAGE_TYPES[mime];
    images.push({
      slot,
      buffer: file.buffer,
      mime,
      ext,
      originalName: String(file.originalname || `${slot}.${ext}`).slice(0, 200),
      size: file.size ?? file.buffer.length,
    });
  }
  return { ok: Object.keys(errors).length === 0, errors, images };
}

module.exports = { sniffImageType, validateStudyImages };
