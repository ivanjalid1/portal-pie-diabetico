'use strict';

const { buildContainer } = require('../../src/container');
const { buildConfig } = require('../../src/config');
const { EVENTS } = require('../../src/utils/eventBus');
const { ValidationError, ForbiddenError, ConflictError } = require('../../src/utils/errors');
const { buildCsv } = require('../../src/utils/csv');

function container() {
  const config = buildConfig({ NODE_ENV: 'test', DATA_DRIVER: 'memory' });
  return buildContainer({ config });
}

const newPatient = (over = {}) => ({
  nombre: 'Lucas',
  apellido: 'Funes',
  email: 'lucas.funes.test@gmail.com',
  telefono: '351 000-0000',
  centro: 'Clínica Reina Fabiola',
  fechaNacimiento: '1966-03-03',
  sexo: 'M',
  tipoDm: 'II',
  aniosEvolucionDm: 9,
  insulinorequiriente: true,
  tabaquismo: null,
  neuropatia: false,
  neuropatiaPuntaje: 0,
  exclusion: {},
  consentimientoFirmado: true,
  consentimientoFecha: '2026-10-01',
  ...over,
});

describe('PatientService', () => {
  let c;
  let medico;
  beforeEach(async () => {
    c = container();
    await c.ready;
    medico = await c.repos.users.findByEmail('medico@demo.com');
  });

  it('registra al paciente, crea su cuenta con contraseña temporal y emite patient.created', async () => {
    const seen = jest.fn();
    c.events.on(EVENTS.PATIENT_CREATED, seen);
    const { patient, user, tempPassword } = await c.services.patientService.register(newPatient(), {
      id: medico.id,
      email: medico.email,
    });
    expect(patient.codigo).toMatch(/^P\.RF\d{3}$/);
    expect(user.role).toBe('paciente');
    expect(user.mustChangePassword).toBe(true);
    expect(tempPassword).toMatch(/^[A-Za-z]{8}\d{2}!$/);
    expect(seen).toHaveBeenCalledTimes(1);
    // Datos personales separados de la ficha clínica.
    const raw = await c.repos.patients.findById(patient.id);
    expect(raw.nombre).toBeUndefined();
    expect(raw.email).toBeUndefined();
    // El paciente puede ingresar con la contraseña temporal.
    const logged = await c.services.authService.login(user.email, tempPassword);
    expect(logged.id).toBe(user.id);
    // Se registra el consentimiento en el historial.
    expect(await c.services.patientService.listConsents(patient.id)).toHaveLength(1);
  });

  it('bloquea el registro si cumple un criterio de exclusión', async () => {
    await expect(
      c.services.patientService.register(newPatient({ exclusion: { ulcerasActivas: true } }), { id: medico.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('exige consentimiento firmado y código único', async () => {
    await expect(
      c.services.patientService.register(newPatient({ consentimientoFirmado: false }), { id: medico.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      c.services.patientService.register(newPatient({ codigo: 'DEMO-002' }), { id: medico.id }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('un médico no accede a pacientes de otro médico', async () => {
    const otro = await c.repos.users.findByEmail('medico2@demo.com');
    const [ajeno] = await c.repos.patients.listByMedico(otro.id);
    await expect(c.services.patientService.getForMedico(ajeno.id, medico.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('revocar el consentimiento impide cargar nuevos estudios', async () => {
    const [p] = await c.repos.patients.listByMedico(medico.id);
    await c.services.patientService.revokeConsent(p.id, { motivo: 'Decisión del paciente' }, { id: medico.id });
    await expect(
      c.services.studyService.createWithAnalysis(
        { patientId: p.id, acquisition: {}, filesBySlot: {} },
        { id: medico.id },
      ),
    ).rejects.toThrow(/consentimiento/);
  });

  it('registra el desenlace (¿generó lesión?) a nivel paciente', async () => {
    const p = await c.repos.patients.findByCodigo('DEMO-003');
    await c.services.patientService.recordOutcome(
      p.id,
      { generoLesion: true, pie: 'derecho', roi: 'dedo_mayor', fecha: '2026-11-01', notas: '' },
      { id: medico.id },
    );
    const updated = await c.repos.patients.findById(p.id);
    expect(updated.generoLesion).toBe(true);
    expect(updated.lesionRoi).toBe('dedo_mayor');
  });

  it('el listado admite filtro por grupo térmico y búsqueda por nombre o código', async () => {
    const all = await c.services.patientService.listForMedico(medico.id);
    const p = await c.services.patientService.listForMedico(medico.id, { riesgo: 'P' });
    expect(p.every((r) => r.ultimoAnalisis.grupo === 'P')).toBe(true);
    expect(p.length).toBeLessThan(all.length);
    const byName = await c.services.patientService.listForMedico(medico.id, { q: 'gomez' });
    expect(byName.map((r) => r.patient.codigo)).toEqual(['DEMO-002']);
  });
});

describe('Exportación CSV', () => {
  it('usa las columnas de la planilla y no incluye datos personales', async () => {
    const c = container();
    await c.ready;
    const medico = await c.repos.users.findByEmail('medico@demo.com');
    const csv = buildCsv(await c.services.patientService.exportRows(medico.id));
    const [header, ...rows] = csv.replace('﻿', '').trim().split('\r\n');
    expect(header.split(';').slice(0, 3)).toEqual(['ID PACIENTE', 'EDAD', 'SEXO']);
    expect(header).toContain('GENERÓ LESIÓN');
    expect(header).toContain('T1 DIF REG DEDO MAYOR');
    expect(header).toContain('T2 DIF REG DEDO MAYOR');
    expect(header).toContain('T1 GRUPO (P/C)');
    expect(header).toContain('T2 SIMETRICO');
    expect(header).toContain('VARIACION |DIF| METATARSO');
    expect(rows.length).toBeGreaterThanOrEqual(9);
    expect(csv).not.toMatch(/Gómez|gmail|@demo/);
  });
});

describe('AuditService (Observer)', () => {
  it('registra los eventos de dominio publicados', async () => {
    const c = container();
    await c.ready;
    const before = await c.repos.audit.count();
    c.events.publish(EVENTS.REPORT_EXPORTED, {
      actor: { id: 'x', email: 'medico@demo.com' },
      entity: 'estudio',
      entityId: 'e1',
    });
    await new Promise((r) => setImmediate(r));
    expect(await c.repos.audit.count()).toBe(before + 1);
    const [last] = await c.services.auditService.list({ action: EVENTS.REPORT_EXPORTED });
    expect(last.actorEmail).toBe('medico@demo.com');
  });

  it('un error en un suscriptor no interrumpe el caso de uso', () => {
    const c = container();
    c.events.on('x.test', () => {
      throw new Error('falla');
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => c.events.publish('x.test', {})).not.toThrow();
    spy.mockRestore();
  });
});

describe('AuthService', () => {
  it('rechaza credenciales inválidas y cuentas desactivadas', async () => {
    const c = container();
    await c.ready;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(c.services.authService.login('medico@demo.com', 'mala')).rejects.toThrow(/incorrectos/);
    const u = await c.repos.users.findByEmail('medico2@demo.com');
    await c.repos.users.update(u.id, { activo: false });
    await expect(c.services.authService.login('medico2@demo.com', 'Demo1234!')).rejects.toThrow(/desactivada/);
  });
});
