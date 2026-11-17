'use strict';

/**
 * Detecta en un texto de la planilla la marca de que el paciente NO dio su
 * consentimiento (p. ej. «sin consentimiento», «no firmó el consentimiento»,
 * también con errores de tipeo como «concentimiento»). Esos pacientes se
 * excluyen por completo de la carga local y del entrenamiento.
 */
const MARCA =
  /\b(SIN|NO\s+(DIO|DA|FIRMO|FIRMA|OTORGO|PRESTO)(\s+EL)?|RECHAZ[OA](\s+EL)?|NIEGA(\s+EL)?)\s+CO[NM]?[SC]{1,2}E[NM]?TI?MIENTO/;

function marcaSinConsentimiento(texto) {
  const t = String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
  return MARCA.test(t);
}

module.exports = { marcaSinConsentimiento };
