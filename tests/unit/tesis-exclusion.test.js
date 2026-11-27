'use strict';

const { exclusionTesis, observacionesVisibles, conservarMarca } = require('../../src/utils/tesisExclusion');

describe('Marca «NO VALIDO» de la planilla (oculta en la interfaz)', () => {
  it('detecta el motivo a partir de las observaciones de la planilla', () => {
    expect(exclusionTesis('PACIENTE NO VALIDO X IMAGEN')).toBe('imagen');
    expect(exclusionTesis('PACIENTE NO VALIDO POR IMAGEN Es de otra ciudad')).toBe('imagen');
    expect(exclusionTesis('PACIENTE NO VALIDO X IMAGEN. Operada de tobillo')).toBe('imagen');
    expect(exclusionTesis('PACIENTE NO VALIDO X PESO172Kg')).toBe('peso');
    expect(exclusionTesis('OB: Preguntar el peso.')).toBeNull();
    expect(exclusionTesis('neuro leve 3ptos')).toBeNull();
    expect(exclusionTesis(null)).toBeNull();
  });

  it('oculta la marca «NO VALIDO» de las observaciones que se muestran', () => {
    expect(observacionesVisibles('PACIENTE NO VALIDO X IMAGEN')).toBeNull();
    expect(observacionesVisibles('PACIENTE NO VALIDO X PESO172Kg')).toBeNull();
    expect(observacionesVisibles('PACIENTE NO VALIDO X IMAGEN. Operada de tobillo')).toBe('Operada de tobillo');
    expect(observacionesVisibles('PACIENTE NO VALIDO POR IMAGEN Es de otra ciudad')).toBe('Es de otra ciudad');
    expect(observacionesVisibles('OB: Preguntar el peso.')).toBe('OB: Preguntar el peso.');
    expect(observacionesVisibles(null)).toBeNull();
  });

  it('al guardar la ficha conserva la marca interna (sigue fuera del entrenamiento)', () => {
    expect(conservarMarca('PACIENTE NO VALIDO X IMAGEN. Operada', 'Operada de tobillo')).toBe(
      'PACIENTE NO VALIDO X IMAGEN. Operada de tobillo',
    );
    expect(conservarMarca('PACIENTE NO VALIDO X PESO172Kg', '')).toBe('PACIENTE NO VALIDO X PESO172Kg');
    expect(exclusionTesis(conservarMarca('PACIENTE NO VALIDO X PESO172Kg', 'nota'))).toBe('peso');
    expect(conservarMarca('neuro leve', 'neuro moderada')).toBe('neuro moderada');
  });
});
