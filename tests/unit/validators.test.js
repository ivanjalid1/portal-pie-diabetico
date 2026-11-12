'use strict';

const schemas = require('../../src/validators/schemas');
const { sniffImageType, validateStudyImages } = require('../../src/validators/imageValidator');

const validPatient = {
  nombre: 'Ana',
  apellido: 'Paz',
  email: ' Ana.Paz@Gmail.com ',
  centro: 'Hospital Córdoba',
  fechaNacimiento: '1970-05-10',
  sexo: 'F',
  tipoDm: 'II',
  aniosEvolucionDm: '10,5',
  hba1c: '7,26',
  tabaquismo: 'a_consultar',
  consentimientoFirmado: 'on',
  consentimientoFecha: '2026-01-10',
};

describe('patientCreateSchema', () => {
  it('normaliza correo, coma decimal y redondea HbA1c a 1 decimal', () => {
    const r = schemas.patientCreateSchema.safeParse(validPatient);
    expect(r.success).toBe(true);
    expect(r.data.email).toBe('ana.paz@gmail.com');
    expect(r.data.aniosEvolucionDm).toBe(10.5);
    expect(r.data.hba1c).toBe(7.3);
    expect(r.data.tabaquismo).toBeNull();
    expect(r.data.dni).toBeNull();
  });

  it('exige puntaje si hay neuropatía', () => {
    const r = schemas.patientCreateSchema.safeParse({ ...validPatient, neuropatia: 'on' });
    expect(r.success).toBe(false);
    expect(r.error.issues[0].path).toEqual(['neuropatiaPuntaje']);
  });

  it('rechaza menores de edad y DNI inválido', () => {
    const r = schemas.patientCreateSchema.safeParse({ ...validPatient, fechaNacimiento: '2015-01-01', dni: '12' });
    expect(r.success).toBe(false);
    const paths = r.error.issues.map((i) => i.path[0]);
    expect(paths).toEqual(expect.arrayContaining(['fechaNacimiento', 'dni']));
  });

  it('valida el formato del código anónimo', () => {
    expect(schemas.patientCreateSchema.safeParse({ ...validPatient, codigo: 'p.rf902' }).data.codigo).toBe('DEMO-005');
    expect(schemas.patientCreateSchema.safeParse({ ...validPatient, codigo: 'X-1' }).success).toBe(false);
  });

  it('vibratoria >50 anula el valor numérico', () => {
    const r = schemas.patientCreateSchema.safeParse({ ...validPatient, vibratoriaDer: '20', vibratoriaDerMas50: 'on' });
    expect(r.data.vibratoriaDer).toBeNull();
    expect(r.data.vibratoriaDerMas50).toBe(true);
    expect(schemas.patientCreateSchema.safeParse({ ...validPatient, vibratoriaIzq: '60' }).success).toBe(false);
  });
});

describe('studySchema', () => {
  const base = {
    patientId: '0b8f3b1e-1c1a-4b8e-9d1a-2f3c4d5e6f70',
    toma: '1',
    fechaHora: '2026-10-01T10:30',
    centro: 'Hospital Córdoba',
    tempAmbiente: '22,4',
    humedadRelativa: '55',
    distanciaCm: '80',
    emisividad: '0,98',
    rangoMin: '24',
    rangoMax: '35',
    paleta: 'Ironbow',
    tiempoEstabilizacionMin: '15',
    fondo: 'Cartulina',
    valida: 'si',
    checklist: ['sin_calzado', 'decubito'],
    consentimientoVerificado: 'on',
  };
  it('acepta una toma válida y convierte la hora local de Córdoba a UTC', () => {
    const r = schemas.studySchema.safeParse(base);
    expect(r.success).toBe(true);
    expect(r.data.fechaHora).toBe('2026-10-01T13:30:00.000Z');
    expect(r.data.valida).toBe(true);
    expect(r.data.toma).toBe(1);
  });
  it('exige motivo cuando la imagen no es válida y la verificación del consentimiento', () => {
    const r = schemas.studySchema.safeParse({ ...base, valida: 'no', consentimientoVerificado: undefined });
    expect(r.success).toBe(false);
    const paths = r.error.issues.map((i) => i.path[0]);
    expect(paths).toEqual(expect.arrayContaining(['motivoInvalidez', 'consentimientoVerificado']));
  });
  it('rechaza una toma distinta de 1 o 2 y un fondo fuera del protocolo', () => {
    const r = schemas.studySchema.safeParse({ ...base, toma: '3', fondo: 'Madera' });
    expect(r.success).toBe(false);
  });
});

describe('outcomeSchema', () => {
  it('exige pie y ROI si generó lesión', () => {
    const r = schemas.outcomeSchema.safeParse({ generoLesion: 'si', fecha: '2026-01-01' });
    expect(r.success).toBe(false);
  });
  it('limpia pie y ROI si no generó lesión', () => {
    const r = schemas.outcomeSchema.safeParse({
      generoLesion: 'no',
      pie: 'derecho',
      roi: 'talon',
      fecha: '2026-01-01',
    });
    expect(r.data).toMatchObject({ generoLesion: false, pie: null, roi: null });
  });
});

describe('changePasswordSchema', () => {
  it('exige contraseña robusta y confirmación', () => {
    expect(schemas.changePasswordSchema.safeParse({ actual: 'x', nueva: 'abc', confirmacion: 'abc' }).success).toBe(
      false,
    );
    expect(
      schemas.changePasswordSchema.safeParse({ actual: 'x', nueva: 'Segura123', confirmacion: 'Otra123x' }).success,
    ).toBe(false);
    expect(
      schemas.changePasswordSchema.safeParse({ actual: 'x', nueva: 'Segura123', confirmacion: 'Segura123' }).success,
    ).toBe(true);
  });
});

describe('imageValidator', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);

  it('detecta el tipo por la firma y no por la extensión', () => {
    expect(sniffImageType(png)).toBe('image/png');
    expect(sniffImageType(jpg)).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('<svg>'))).toBeNull();
  });
  it('acepta IS2 (ZIP de Fluke) sólo con extensión .is2', () => {
    expect(sniffImageType(zip, 'IR_0001.IS2')).toBe('application/x-fluke-is2');
    expect(sniffImageType(zip, 'malicioso.zip')).toBeNull();
  });
  it('exige las dos imágenes del estudio', () => {
    const r = validateStudyImages({ termografia: { buffer: png, size: 8, originalname: 'a.png' } }, 1024);
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors)).toEqual(['visible']);
  });
  it('rechaza archivos que superan el tamaño máximo', () => {
    const big = { buffer: png, size: 5000, originalname: 'a.png' };
    const r = validateStudyImages({ termografia: big, visible: big }, 1000);
    expect(r.ok).toBe(false);
  });
});
