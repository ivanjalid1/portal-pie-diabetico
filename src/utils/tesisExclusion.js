'use strict';

/**
 * Pacientes marcados en la planilla clínica (columna OBSERVACIONES) como
 * «PACIENTE NO VALIDO X IMAGEN» (o «X PESO…»): fueron excluidos en la Parte 1
 * de la tesis. En el portal siguen visibles y se evalúan con los mismos
 * criterios automáticos de calidad de foto que el resto; la marca sólo se
 * muestra como un dato histórico neutro. Siguen fuera del entrenamiento de
 * los modelos y de la referencia del TCI (`clinica.noValido`).
 *
 * El motivo «peso» corresponde al criterio de exclusión de peso > 150 kg.
 */

/** Motivo de la exclusión en la Parte 1 a partir del texto de observaciones: 'imagen' | 'peso' | null. */
function exclusionTesis(observaciones) {
  const s = String(observaciones || '');
  if (!/NO\s+V[AÁ]LIDO/i.test(s)) return null;
  return /PESO/i.test(s) ? 'peso' : 'imagen';
}

const ETIQUETAS = Object.freeze({
  imagen: 'Excluido en la tesis de Ana (imagen)',
  peso: 'Excluido en la tesis de Ana (peso > 150 kg)',
});

/**
 * Etiqueta histórica para las vistas.
 * @param {{observaciones?: string|null}|string|null} patientOrObs paciente u observaciones
 * @returns {string|null}
 */
function etiquetaExclusionTesis(patientOrObs) {
  const obs = typeof patientOrObs === 'string' ? patientOrObs : patientOrObs?.observaciones;
  const m = exclusionTesis(obs);
  return m ? ETIQUETAS[m] : null;
}

module.exports = { exclusionTesis, etiquetaExclusionTesis, ETIQUETAS };
