'use strict';

const { ROLE_HOME } = require('../models/roles');

function createPublicController({ config, analysisService }) {
  return {
    /** Sin landing: la raíz lleva al login o al panel del rol si ya hay sesión. */
    home(req, res) {
      res.redirect(302, req.user ? ROLE_HOME[req.user.role] || '/login' : '/login');
    },

    health(_req, res) {
      res.json({
        status: 'ok',
        app: config.appName,
        driver: config.dataDriver,
        predictor: analysisService.predictorInfo.version,
        time: new Date().toISOString(),
      });
    },
  };
}

module.exports = { createPublicController };
