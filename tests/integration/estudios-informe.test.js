'use strict';

const { makeApp, loginAs } = require('../helpers/agent');
const thermal = require('../../src/utils/thermal');
const lut = require('../../src/config/palettes/high-contrast.json');

describe('Estudios realizados, informe del paciente y paletas', () => {
  let app;
  let container;
  let medicoUser;
  let medico;
  beforeAll(async () => {
    ({ app, container } = makeApp());
    await container.ready;
    medicoUser = await container.repos.users.findByEmail('medico@demo.com');
    medico = await loginAs(app, 'medico@demo.com');
  });

  describe('búsqueda de estudios (médico)', () => {
    it('lista todos los estudios con su tendencia y nivel', async () => {
      const res = await medico.get('/medico/estudios');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Estudios realizados');
      expect(res.text).toMatch(/\d+<\/strong> estudios/);
    });

    it('busca por apellido sin distinguir acentos ni mayúsculas, y por código', async () => {
      const patients = await container.repos.patients.listByMedico(medicoUser.id);
      const studies = await container.repos.studies.listByMedico(medicoUser.id);
      const conEstudio = patients.find((p) => studies.some((s) => s.patientId === p.id) && p.userId);
      const user = await container.repos.users.findById(conEstudio.userId);
      const apellido = user.apellido
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toUpperCase();

      const byName = await container.services.studyService.searchForMedico(medicoUser.id, { q: apellido });
      expect(byName.total).toBeGreaterThan(0);
      expect(byName.all.every((r) => r.patient.id === conEstudio.id || r.patient.apellido)).toBe(true);
      expect(byName.all.some((r) => r.patient.id === conEstudio.id)).toBe(true);

      const byCode = await container.services.studyService.searchForMedico(medicoUser.id, {
        q: conEstudio.codigo.toLowerCase(),
      });
      expect(byCode.all.every((r) => r.patient.codigo === conEstudio.codigo)).toBe(true);

      const none = await container.services.studyService.searchForMedico(medicoUser.id, { q: 'zzz-no-existe' });
      expect(none.total).toBe(0);
    });

    it('filtra por riesgo y grupo, ordena por probabilidad y pagina', async () => {
      const svc = container.services.studyService;
      const alto = await svc.searchForMedico(medicoUser.id, { riesgo: 'alto' });
      expect(alto.all.every((r) => r.analysis.categoria === 'alto')).toBe(true);
      const conAsim = await svc.searchForMedico(medicoUser.id, { grupo: 'P' });
      expect(conAsim.all.every((r) => r.analysis.grupo === 'P')).toBe(true);
      const ord = await svc.searchForMedico(medicoUser.id, { orden: 'probabilidad', dir: 'desc' });
      const probs = ord.all.map((r) => r.analysis.probabilidad);
      expect(probs).toEqual([...probs].sort((a, b) => b - a));
      expect(ord.items.length).toBeLessThanOrEqual(10);
    });

    it('exporta el CSV del filtro actual conservando las columnas P/C', async () => {
      const res = await medico.get('/medico/estudios/exportar.csv?riesgo=alto');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.text).toMatch(/GRUPO/);
    });

    it('rechaza filtros inválidos sin romper la página', async () => {
      const res = await medico.get('/medico/estudios?riesgo=<script>&page=-3');
      expect([200, 400]).toContain(res.status);
      expect(res.text).not.toContain('<script>');
    });

    it('el paciente no puede usar la búsqueda por nombre', async () => {
      const paciente = await loginAs(app, 'paciente@demo.com');
      const res = await paciente.get('/medico/estudios?q=a');
      expect(res.status).toBe(403);
    });
  });

  describe('etiquetas de grupo y tablero', () => {
    it('muestra «Con/Sin asimetría» con la ayuda en lugar de letras sueltas', async () => {
      const res = await medico.get('/medico');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/con asimetría/);
      expect(res.text).toContain('Asimetría en aumento');
      expect(res.text).not.toContain('en grupo P');
    });

    it('la ficha del paciente usa gráficos SVG sin doble eje ni Chart.js', async () => {
      const studies = await container.repos.studies.listByMedico(medicoUser.id);
      const res = await medico.get(`/medico/pacientes/${studies[0].patientId}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('class="dumbbell');
      expect(res.text).toContain('class="slope"');
      expect(res.text).not.toMatch(/chart\.js|chart\.umd/i);
    });
  });

  describe('informe del paciente', () => {
    it('muestra «Tu informe» y su versión imprimible sólo si el estudio está publicado', async () => {
      const pacUser = await container.repos.users.findByEmail('paciente@demo.com');
      const patient = await container.repos.patients.findByUserId(pacUser.id);
      const studies = await container.repos.studies.listByPatient(patient.id);
      const publicado = studies.find((s) => s.publicado);
      expect(publicado).toBeDefined();

      const paciente = await loginAs(app, 'paciente@demo.com');
      const det = await paciente.get(`/paciente/estudios/${publicado.id}`);
      expect(det.status).toBe(200);
      expect(det.text).toContain('Tu informe');
      expect(det.text).toContain('Descargar informe (PDF)');

      const inf = await paciente.get(`/paciente/estudios/${publicado.id}/informe`);
      expect(inf.status).toBe(200);
      expect(inf.text).toMatch(/orientativo/);

      await container.repos.studies.update(publicado.id, { publicado: false });
      const oculto = await paciente.get(`/paciente/estudios/${publicado.id}/informe`);
      expect(oculto.status).toBe(404);
      await container.repos.studies.update(publicado.id, { publicado: true });
    });
  });

  describe('paletas', () => {
    it('la LUT High Contrast tiene 256 colores RGB válidos', () => {
      expect(lut.lut).toHaveLength(256);
      expect(lut.lut.every((c) => c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255))).toBe(
        true,
      );
    });

    it('expone High Contrast (por defecto), Ironbow y Grises', () => {
      expect(Object.keys(thermal.PALETTES)).toEqual(expect.arrayContaining(['alto_contraste', 'ironbow', 'grises']));
      expect(thermal.DEFAULT_PALETTE).toBe('alto_contraste');
      expect(thermal.highContrast(0)).toEqual(lut.lut[0]);
      expect(thermal.highContrast(1)).toEqual(lut.lut[255]);
    });

    it('el visor ofrece las variantes pre-renderizadas de las imágenes demo', async () => {
      const studies = await container.repos.studies.listByMedico(medicoUser.id);
      const res = await medico.get(`/medico/estudios/${studies[0].id}`);
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/data-palettes="[^"]*ironbow/);
      expect(res.text).toContain('name="lb-paleta"');
    });
  });
});
