'use strict';

const { exclusionTesis, etiquetaExclusionTesis } = require('../../src/utils/tesisExclusion');

describe('Etiqueta histórica «Excluido en la tesis de Ana»', () => {
  it('detecta el motivo a partir de las observaciones de la planilla', () => {
    expect(exclusionTesis('PACIENTE NO VALIDO X IMAGEN')).toBe('imagen');
    expect(exclusionTesis('PACIENTE NO VALIDO POR IMAGEN Es de otra ciudad')).toBe('imagen');
    expect(exclusionTesis('PACIENTE NO VALIDO X IMAGEN. Operada de tobillo')).toBe('imagen');
    expect(exclusionTesis('PACIENTE NO VALIDO X PESO172Kg')).toBe('peso');
    expect(exclusionTesis('OB: Preguntar el peso.')).toBeNull();
    expect(exclusionTesis('neuro leve 3ptos')).toBeNull();
    expect(exclusionTesis(null)).toBeNull();
  });

  it('arma el texto neutro para las vistas (paciente u observaciones)', () => {
    expect(etiquetaExclusionTesis({ observaciones: 'PACIENTE NO VALIDO X IMAGEN' })).toBe(
      'Excluido en la tesis de Ana (imagen)',
    );
    expect(etiquetaExclusionTesis('PACIENTE NO VALIDO X PESO172Kg')).toBe('Excluido en la tesis de Ana (peso > 150 kg)');
    expect(etiquetaExclusionTesis({ observaciones: null })).toBeNull();
    expect(etiquetaExclusionTesis(null)).toBeNull();
  });
});
