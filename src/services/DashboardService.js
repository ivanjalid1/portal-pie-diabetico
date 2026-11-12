'use strict';

const PatientView = require('../models/PatientView');

/** Indicadores agregados para los tableros del médico y del administrador. */
class DashboardService {
  constructor({ patients, studies, analyses, appointments, users, audit, analysisService, config }) {
    this.patients = patients;
    this.studies = studies;
    this.analyses = analyses;
    this.appointments = appointments;
    this.users = users;
    this.audit = audit;
    this.analysisService = analysisService;
    this.config = config;
  }

  async medico(medicoId, now = new Date()) {
    const [rawPatients, studies, appts] = await Promise.all([
      this.patients.listByMedico(medicoId),
      this.studies.listByMedico(medicoId),
      this.appointments.listByMedico(medicoId),
    ]);
    const users = await this.users.findByIds(rawPatients.map((p) => p.userId).filter(Boolean));
    const uById = new Map(users.map((u) => [u.id, u]));
    const patients = rawPatients.map((p) => PatientView.from(p, uById.get(p.userId)));
    const analyses = await this.analyses.listByStudyIds(studies.map((s) => s.id));
    const aByStudy = new Map(analyses.map((a) => [a.studyId, a]));
    const pById = new Map(patients.map((p) => [p.id, p]));

    const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);
    const estudiosMes = studies.filter((s) => new Date(s.fechaHora) >= inicioMes).length;

    // Último resultado de cada paciente (los estudios vienen ordenados por fecha desc.).
    const ultimo = new Map();
    for (const s of studies) {
      if (!ultimo.has(s.patientId) && aByStudy.has(s.id)) ultimo.set(s.patientId, aByStudy.get(s.id));
    }
    const altoRiesgo = [...ultimo.values()].filter((a) => a.categoria === 'alto').length;
    const distribucion = { sin_riesgo: 0, moderado: 0, alto: 0 };
    for (const a of ultimo.values()) distribucion[a.categoria] += 1;

    const pendientes = appts.filter((a) => a.estado === 'pendiente');
    const recientes = studies.slice(0, 6).map((study) => ({
      study,
      patient: pById.get(study.patientId),
      analysis: aByStudy.get(study.id) || null,
    }));
    const proximosControles = pendientes.slice(0, 6).map((appt) => ({ appt, patient: pById.get(appt.patientId) }));
    // Pacientes con al menos un estudio cuyo desenlace (¿generó lesión?) aún no se registró.
    const conEstudio = new Set(studies.map((s) => s.patientId));
    const sinDesenlace = patients.filter((p) => conEstudio.has(p.id) && p.generoLesion === null).length;
    const grupos = { P: 0, C: 0 };
    for (const a of ultimo.values()) if (a.grupo) grupos[a.grupo] += 1;

    return {
      kpis: {
        pacientes: patients.length,
        estudiosMes,
        altoRiesgo,
        controlesPendientes: pendientes.length,
        controlesVencidos: pendientes.filter((a) => a.vencido(now)).length,
        sinDesenlace,
      },
      distribucion,
      grupos,
      recientes,
      proximosControles,
    };
  }

  async admin(now = new Date()) {
    const [porRol, studies, analyses, auditCount, recentAudit, patientsCount] = await Promise.all([
      this.users.countByRole(),
      this.studies.listAll(),
      this.analyses.listAll(),
      this.audit.count(),
      this.audit.list({ limit: 8 }),
      this.patients.count(),
    ]);
    const categorias = { sin_riesgo: 0, moderado: 0, alto: 0 };
    for (const a of analyses) categorias[a.categoria] = (categorias[a.categoria] || 0) + 1;

    const meses = [];
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      meses.push({
        mes: d.toISOString(),
        estudios: studies.filter((s) => new Date(s.fechaHora) >= d && new Date(s.fechaHora) < next).length,
      });
    }
    const allPatients = await this.patients.listAll();
    const conDesenlace = allPatients.filter((p) => p.generoLesion !== null);
    const grupos = { P: 0, C: 0 };
    for (const a of analyses) if (a.grupo) grupos[a.grupo] += 1;
    return {
      porRol,
      pacientes: patientsCount,
      estudios: studies.length,
      analisis: analyses.length,
      publicados: studies.filter((s) => s.publicado).length,
      desenlaces: { total: conDesenlace.length, lesion: conDesenlace.filter((p) => p.generoLesion).length },
      grupos,
      categorias,
      meses,
      auditCount,
      recentAudit,
      sistema: {
        driver: this.config.dataDriver,
        predictor: this.analysisService.predictorInfo,
        entorno: this.config.env,
        node: process.version,
      },
    };
  }
}

module.exports = DashboardService;
