'use strict';

module.exports = {
  User: require('./User'),
  Patient: require('./Patient'),
  Study: require('./Study'),
  AnalysisResult: require('./AnalysisResult'),
  Appointment: require('./Appointment'),
  AuditEntry: require('./AuditEntry'),
  Consent: require('./Consent'),
  PatientView: require('./PatientView'),
  ...require('./roles'),
};
