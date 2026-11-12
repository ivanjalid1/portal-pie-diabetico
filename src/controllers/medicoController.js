'use strict';

const AppointmentService = require('../services/AppointmentService');
const { CENTRO_NOMBRES, IMAGE_SLOTS, CENTROS } = require('../config/domain');
const { buildCsv } = require('../utils/csv');
const { EVENTS } = require('../utils/eventBus');

/** Asocia a un error de negocio la URL del formulario al que debe volver. */
async function withBack(back, fn) {
  try {
    return await fn();
  } catch (err) {
    if (!err.back) err.back = back;
    throw err;
  }
}

const RIESGO_FILTROS = ['alto', 'moderado', 'sin_riesgo', 'P', 'C', 'sin_estudios'];

/** Controlador de la sección del médico/a (pacientes, estudios y análisis). */
function createMedicoController({
  dashboardService,
  patientService,
  studyService,
  appointmentService,
  events,
  config,
}) {
  const actor = (req) => ({ id: req.user.id, email: req.user.email, ip: req.ip, role: req.user.role });
  const defaultCentro = (req) =>
    CENTRO_NOMBRES.includes(req.user.institucion) ? req.user.institucion : CENTRO_NOMBRES[0];

  return {
    async dashboard(req, res) {
      const data = await dashboardService.medico(req.user.id);
      res.render('medico/dashboard', { title: 'Tablero', ...data });
    },

    /* ---------- Pacientes ---------- */

    async patients(req, res) {
      const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '';
      const riesgo = RIESGO_FILTROS.includes(req.query.riesgo) ? req.query.riesgo : '';
      const rows = await patientService.listForMedico(req.user.id, { q, riesgo });
      res.render('medico/patients', { title: 'Pacientes', rows, q, riesgo });
    },

    async newPatient(req, res) {
      const centro = res.locals.old.centro || defaultCentro(req);
      const sugeridos = {};
      for (const c of CENTROS) sugeridos[c.nombre] = await patientService.nextCodigo(c.nombre);
      res.render('medico/patient-form', {
        title: 'Registrar paciente',
        mode: 'create',
        patient: null,
        centros: CENTRO_NOMBRES,
        centro,
        codigosSugeridos: sugeridos,
      });
    },

    async createPatient(req, res) {
      const { patient, user, tempPassword } = await withBack('/medico/pacientes/nuevo', () =>
        patientService.register(req.validated, actor(req)),
      );
      res.status(201).render('medico/patient-created', {
        title: 'Paciente registrado',
        patient,
        account: user,
        tempPassword,
        appUrl: config.appUrl,
      });
    },

    async patientDetail(req, res) {
      const patient = await patientService.getForMedico(req.params.id, req.user.id);
      const [{ items, serie }, appointments, consents] = await Promise.all([
        patientService.history(patient.id),
        appointmentService.listForPatient(patient.id),
        patientService.listConsents(patient.id),
      ]);
      res.render('medico/patient-detail', {
        title: `${patient.codigo} · ${patient.nombreCompleto}`,
        patient,
        items,
        serie,
        appointments,
        consents,
        proximo: appointments.find((a) => a.estado === 'pendiente') || null,
      });
    },

    async editPatient(req, res) {
      const patient = await patientService.getForMedico(req.params.id, req.user.id);
      res.render('medico/patient-form', {
        title: `Editar ${patient.codigo}`,
        mode: 'edit',
        patient,
        centros: CENTRO_NOMBRES,
        centro: patient.centro,
        codigosSugeridos: {},
      });
    },

    async updatePatient(req, res) {
      await patientService.update(req.params.id, req.validated, actor(req));
      req.flash('success', 'Guardaste los datos clínicos.');
      res.redirect(303, `/medico/pacientes/${req.params.id}`);
    },

    async outcome(req, res) {
      await patientService.recordOutcome(req.params.id, req.validated, actor(req));
      req.flash('success', 'Registraste el desenlace del seguimiento.');
      const back =
        typeof req.body.volver === 'string' && req.body.volver.startsWith('/medico/') ? req.body.volver : null;
      res.redirect(303, back || `/medico/pacientes/${req.params.id}#desenlace`);
    },

    async signConsent(req, res) {
      await patientService.registerConsent(req.params.id, req.validated, actor(req));
      req.flash('success', 'Registraste el consentimiento informado.');
      res.redirect(303, `/medico/pacientes/${req.params.id}#consentimiento`);
    },

    async revokeConsent(req, res) {
      await patientService.revokeConsent(req.params.id, req.validated, actor(req));
      req.flash('info', 'Registraste la revocación del consentimiento. No se podrán cargar nuevos estudios.');
      res.redirect(303, `/medico/pacientes/${req.params.id}#consentimiento`);
    },

    async exportCsv(req, res) {
      const rows = await patientService.exportRows(req.user.id);
      events.publish(EVENTS.DATA_EXPORTED, {
        actor: actor(req),
        entity: 'paciente',
        detail: `CSV anonimizado · ${rows.length} filas`,
      });
      const stamp = new Date().toISOString().slice(0, 10);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="termopie-mediciones-${stamp}.csv"`);
      res.send(buildCsv(rows));
    },

    /* ---------- Estudios ---------- */

    async newStudy(req, res) {
      const rows = await patientService.listForMedico(req.user.id);
      const selectedId = typeof req.query.paciente === 'string' ? req.query.paciente : res.locals.old.patientId || '';
      const selectedRow = rows.find((r) => r.patient.id === selectedId) || null;
      res.render('medico/study-wizard', {
        title: 'Nuevo estudio termográfico',
        rows,
        selected: selectedRow?.patient || null,
        tomaSugerida: selectedRow && selectedRow.estudios > 0 ? 2 : 1,
        centros: CENTRO_NOMBRES,
        defaultCentro: selectedRow?.patient.centro || defaultCentro(req),
        imageSlots: IMAGE_SLOTS,
        maxFileMb: config.uploads.maxFileMb,
      });
    },

    async createStudy(req, res) {
      const filesBySlot = Object.fromEntries(IMAGE_SLOTS.map(({ slot }) => [slot, req.files?.[slot]?.[0] || null]));
      const { patientId, consentimientoVerificado: _c, ...acquisition } = req.validated;
      const { study } = await withBack(`/medico/estudios/nuevo?paciente=${encodeURIComponent(patientId)}`, () =>
        studyService.createWithAnalysis({ patientId, acquisition, filesBySlot }, actor(req)),
      );
      req.flash('success', 'Análisis completado. Revisá el resultado antes de hacerlo visible al paciente.');
      res.redirect(303, `/medico/estudios/${study.id}`);
    },

    async studyDetail(req, res) {
      const data = await studyService.getForMedico(req.params.id, req.user.id);
      res.render('medico/study-result', {
        title: `Estudio ${data.patient.codigo} · toma ${data.study.toma}`,
        ...data,
        proximo: data.appointments.find((a) => a.estado === 'pendiente') || null,
        defaultControl: AppointmentService.defaultDate(data.study.fechaHora),
        imageSlots: IMAGE_SLOTS,
        predictorInfo: studyService.analysisService.predictorInfo,
      });
    },

    async saveNotes(req, res) {
      await studyService.updateNotes(req.params.id, req.validated.notasMedico, actor(req));
      req.flash('success', 'Guardaste las notas.');
      res.redirect(303, `/medico/estudios/${req.params.id}#notas`);
    },

    async publish(req, res) {
      const { publicado } = req.validated;
      await studyService.setPublished(req.params.id, publicado, actor(req));
      req.flash(
        'success',
        publicado
          ? 'El resultado ya es visible para el paciente.'
          : 'El resultado dejó de ser visible para el paciente.',
      );
      res.redirect(303, `/medico/estudios/${req.params.id}`);
    },

    async scheduleFromStudy(req, res) {
      const { study, patient } = await studyService.getForMedico(req.params.id, req.user.id);
      const appt = await appointmentService.schedule(
        { patient, studyId: study.id, fecha: req.validated.fecha, motivo: req.validated.motivo },
        actor(req),
      );
      req.flash('success', `Programaste el control para el ${res.locals.fmt.dateLong(appt.fecha)}.`);
      res.redirect(303, `/medico/estudios/${req.params.id}#control`);
    },

    async report(req, res) {
      const data = await studyService.exportReport(req.params.id, actor(req));
      res.render('medico/report', {
        layout: false,
        title: `Informe ${data.patient.codigo}`,
        ...data,
        imageSlots: IMAGE_SLOTS,
        generado: new Date(),
        medico: req.user,
      });
    },

    /* ---------- Controles ---------- */

    async appointments(req, res) {
      const rows = await patientService.listForMedico(req.user.id);
      const byId = new Map(rows.map((r) => [r.patient.id, r]));
      const pending = await appointmentService.pendingForMedico(req.user.id);
      res.render('medico/appointments', {
        title: 'Controles',
        items: pending.map((appt) => ({ appt, row: byId.get(appt.patientId) })).filter((i) => i.row),
        now: new Date(),
      });
    },

    async setAppointmentStatus(req, res) {
      await appointmentService.setEstado(req.params.id, req.validated.estado, actor(req));
      req.flash(
        'success',
        req.validated.estado === 'realizado' ? 'Marcaste el control como realizado.' : 'Cancelaste el control.',
      );
      res.redirect(303, '/medico/controles');
    },
  };
}

module.exports = { createMedicoController };
