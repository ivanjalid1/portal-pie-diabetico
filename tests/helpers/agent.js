'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { buildContainer } = require('../../src/container');
const { buildConfig } = require('../../src/config');

/** Crea una app con contenedor propio (datos semilla aislados por test). */
function makeApp(env = {}) {
  const config = buildConfig({ ...process.env, NODE_ENV: 'test', DATA_DRIVER: 'memory', ...env });
  const container = buildContainer({ config });
  const app = createApp(container);
  return { app, container };
}

function extractCsrf(html) {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  return m ? m[1] : null;
}

/** Agente autenticado (mantiene cookies) para un usuario demo. */
async function loginAs(app, email, password = 'Demo1234!') {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const csrf = extractCsrf(page.text);
  const res = await agent.post('/login').type('form').send({ email, password, _csrf: csrf });
  agent.lastLogin = res;
  return agent;
}

async function csrfFrom(agent, url) {
  const res = await agent.get(url);
  return extractCsrf(res.text);
}

module.exports = { makeApp, loginAs, csrfFrom, extractCsrf };
