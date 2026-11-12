'use strict';

const { createApp } = require('./src/app');
const { getConfig } = require('./src/config');

const config = getConfig();
const app = createApp();

app.listen(config.port, () => {
  console.log(`${config.appName} escuchando en http://localhost:${config.port} (driver: ${config.dataDriver})`);
});
