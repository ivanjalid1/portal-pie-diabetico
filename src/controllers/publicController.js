'use strict';

function createPublicController({ config, analysisService }) {
  return {
    landing(req, res) {
      res.render('public/landing', {
        layout: 'public',
        title: 'Termografía plantar y riesgo de úlcera',
        predictor: analysisService.predictorInfo,
      });
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
