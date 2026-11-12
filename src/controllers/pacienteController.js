'use strict';

const { IMAGE_SLOTS, EXCLUSION_CRITERIA } = require('../config/domain');
const { SELF_CARE } = require('../config/selfCare');

/** Portal del paciente: lenguaje simple, sin métricas crudas del modelo. */
function createPacienteController({ studyService, appointmentService, patientService }) {
  return {
    async home(req, res) {
      const { patient, items } = await studyService.listForPaciente(req.user.id);
      const ultimo = items.find((i) => i.analysis) || null;
      const proximo = await appointmentService.nextForPatient(patient.id);
      res.render('paciente/home', {
        title: 'Inicio',
        patient,
        ultimo,
        proximo,
        totalEstudios: items.length,
        consejos: SELF_CARE.slice(0, 3),
      });
    },

    async studies(req, res) {
      const { patient, items } = await studyService.listForPaciente(req.user.id);
      res.render('paciente/studies', { title: 'Mis estudios', patient, items });
    },

    async studyDetail(req, res) {
      const data = await studyService.getForPaciente(req.params.id, req.user.id);
      const proximo = await appointmentService.nextForPatient(data.patient.id);
      res.render('paciente/study-detail', { title: 'Detalle del estudio', ...data, proximo, imageSlots: IMAGE_SLOTS });
    },

    selfCare(req, res) {
      res.render('paciente/self-care', { title: 'Cuidado de los pies', consejos: SELF_CARE });
    },

    async myData(req, res) {
      const patient = await patientService.getByUserId(req.user.id);
      const consents = await patientService.listConsents(patient.id);
      res.render('paciente/my-data', { title: 'Mis datos', patient, consents, exclusion: EXCLUSION_CRITERIA });
    },
  };
}

module.exports = { createPacienteController };
