'use strict';

/**
 * Contorno (máscara de los pies) corregido a mano en una foto (réplica) de una
 * toma. La máscara —etiquetas 320 × 240: 0 fondo, 1 pie a la izquierda de la
 * imagen, 2 a la derecha— y las grillas recalculadas con ella viven en el
 * almacenamiento privado (`storagePath`); esta fila dice quién la corrigió y
 * cuándo. Sólo cambia qué píxeles son pie: las temperaturas no se tocan.
 */
class MaskCorrection {
  constructor(r) {
    this.id = r.id;
    this.studyId = r.studyId;
    this.toma = Number(r.toma);
    this.replica = Number(r.replica);
    this.storagePath = r.storagePath || null;
    this.clave = r.clave || null;
    this.pixeles = r.pixeles || null;
    this.corregidoPor = r.corregidoPor || null;
    this.corregidoAt = r.corregidoAt || null;
    this.createdAt = r.createdAt || new Date().toISOString();
    this.updatedAt = r.updatedAt || null;
  }
}

/** Píxeles mínimos por pie de un contorno corregido (como las máscaras externas, src/imaging/pointwise.js). */
MaskCorrection.PIXELES_MINIMOS = 250;
/** Meta de contornos corregidos a mano para reentrenar y evaluar la U-Net. */
MaskCorrection.META = Object.freeze({ min: 30, max: 50 });

module.exports = MaskCorrection;
