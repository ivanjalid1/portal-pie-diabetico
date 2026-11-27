'use strict';

/**
 * Pacientes marcados en la planilla clínica (columna OBSERVACIONES) como
 * «PACIENTE NO VALIDO X IMAGEN» (o «X PESO…»): fueron excluidos en la Parte 1
 * de la tesis. En el portal se evalúan con los mismos criterios automáticos de
 * calidad de foto que el resto y la marca **no se muestra**: sólo sirve para
 * dejarlos fuera del entrenamiento de los modelos y de la referencia del TCI
 * (`clinica.noValido`). El motivo «peso» corresponde a peso > 150 kg.
 */

const MARCA = /PACIENTE\s+NO\s+V[AÁ]LIDO(?:\s+(?:X|POR|PARA))?(?:\s*(?:IMAGEN|PESO\s*\d*\s*(?:KG)?))?\s*\.?/i;

/** Motivo de la exclusión en la Parte 1 a partir del texto de observaciones: 'imagen' | 'peso' | null. */
function exclusionTesis(observaciones) {
  const s = String(observaciones || '');
  if (!/NO\s+V[AÁ]LIDO/i.test(s)) return null;
  return /PESO/i.test(s) ? 'peso' : 'imagen';
}

/** Marca «PACIENTE NO VALIDO…» tal como figura en el texto, o null. */
function marcaExclusion(observaciones) {
  const m = String(observaciones || '').match(MARCA);
  return m ? m[0].trim() : null;
}

/** Observaciones para mostrar: sin la marca interna «NO VALIDO» (null si no queda nada). */
function observacionesVisibles(observaciones) {
  if (!observaciones) return observaciones ?? null;
  const s = String(observaciones).replace(MARCA, ' ').replace(/\s+/g, ' ').trim();
  return s || null;
}

/**
 * Al guardar la ficha (el formulario muestra las observaciones sin la marca),
 * conserva la marca interna que tenían antes.
 */
function conservarMarca(anteriores, nuevas) {
  const marca = marcaExclusion(anteriores);
  if (!marca || exclusionTesis(nuevas)) return nuevas;
  const resto = String(nuevas || '').trim();
  return resto ? `${marca} ${resto}` : marca;
}

module.exports = { exclusionTesis, marcaExclusion, observacionesVisibles, conservarMarca };
