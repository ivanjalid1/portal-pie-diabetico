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
      expect(res.text).toContain('Mayor asimetría punto a punto');
      expect(res.text).not.toContain('Asimetría en aumento');
      expect(res.text).not.toContain('en grupo P');
    });

    it('la ficha del paciente muestra la evolución punto a punto (SVG + mapas) sin el bloque de evolución por regiones', async () => {
      const studies = await container.repos.studies.listByMedico(medicoUser.id);
      const res = await medico.get(`/medico/pacientes/${studies[0].patientId}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('class="pw-evo__chart"');
      expect(res.text).toMatch(/data-pw-map="\d:dt"/);
      expect(res.text).not.toContain('Evolución entre tomas');
      expect(res.text).not.toContain('class="dumbbell');
      expect(res.text).not.toContain('Mayor diferencia entre pies');
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
      expect(det.text).toContain('Qué mostró tu estudio');
      expect(det.text).not.toContain('Primer estudio → control');
      expect(det.text).not.toContain('Mayor diferencia de temperatura entre tus pies');
      expect(det.text).toContain('Descargar informe (PDF)');

      const inf = await paciente.get(`/paciente/estudios/${publicado.id}/informe`);
      expect(inf.status).toBe(200);
      expect(inf.text).toContain('Mi informe de termografía');
      // Sin frases de descargo en las vistas del paciente.
      expect(inf.text).not.toMatch(/orientativo|No es un diagnóstico/);
      expect(det.text).not.toMatch(/orientativo|No es un diagnóstico/);

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

  describe('resultado y login', () => {
    it('el resultado resume en lenguaje simple, muestra mapas por toma y deja el detalle técnico plegado', async () => {
      const studies = await container.repos.studies.listByMedico(medicoUser.id);
      const res = await medico.get(`/medico/estudios/${studies[0].id}`);
      expect(res.status).toBe(200);
      // Resumen: una frase, números grandes y el modelo preliminar como dato secundario.
      expect(res.text).toMatch(/class="sr-summary__lead">(El \d+ % de la planta|Los dos pies)/);
      expect(res.text).not.toContain('Modelo preliminar · no validado');
      expect(res.text).toContain('Patrón térmico compatible con pie diabético');
      expect(res.text).toContain('no predice úlcera');
      expect(res.text).toContain('role="tooltip"');
      // Mapas: pestañas Toma 1 / Toma 2 / Cambio.
      expect(res.text).toContain('role="tablist"');
      expect(res.text).toContain('data-pw-map="1:dt"');
      expect(res.text).toContain('data-pw-map="2:dt"');
      expect(res.text).toContain('data-pw-map="cambio:izq"');
      expect(res.text).toMatch(/<details class="disclosure disclosure--card sr-tech"/);
      expect(res.text).toContain('data-pw-hist="1"');
      // Acciones del médico.
      expect(res.text).toContain(`action="/medico/estudios/${studies[0].id}/publicacion"`);
      expect(res.text).toContain(`action="/medico/estudios/${studies[0].id}/notas"`);
      expect(res.text).toContain(`href="/medico/estudios/${studies[0].id}/informe"`);
      // Sin contenido de la Parte 1 (regiones, grupos P/C, 2,2 °C) ni el aviso largo.
      expect(res.text).not.toContain('regions-ref');
      expect(res.text).not.toContain('roi-pair__item');
      expect(res.text).not.toContain('class="plantar-map');
      expect(res.text).not.toMatch(/class="grupo/);
      expect(res.text).not.toContain('Parte 1');
      expect(res.text).not.toContain('Herramienta exploratoria');
      expect(res.text).not.toContain('evo-banner');
    });

    it('el informe imprimible usa el mismo resumen y no incluye las regiones de la Parte 1', async () => {
      const studies = await container.repos.studies.listByMedico(medicoUser.id);
      const res = await medico.get(`/medico/estudios/${studies[0].id}/informe`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('class="report__lead"');
      expect(res.text).not.toContain('Modelo preliminar · no validado');
      expect(res.text).toContain('Patrón térmico compatible con pie diabético');
      expect(res.text).toContain('no predice úlcera');
      expect(res.text).not.toContain('Referencia: regiones');
      expect(res.text).not.toContain('Parte 1');
      expect(res.text).not.toContain('Herramienta exploratoria');
    });

    it('el menú no duplica «Nuevo estudio» y lo agrupa en Estudios realizados', async () => {
      const res = await medico.get('/medico/estudios/nuevo');
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(
        /class="nav__link[^"]*" ?[^>]*href="\/medico\/estudios\/nuevo"|href="\/medico\/estudios\/nuevo" class="nav__link/,
      );
      expect(res.text).toMatch(/href="\/medico\/estudios" class="nav__link is-active" aria-current="page"/);
      const lista = await medico.get('/medico/estudios');
      expect(lista.text).toMatch(/href="\/medico\/estudios\/nuevo"[^>]*>[\s\S]{0,400}Nuevo estudio/);
    });

    it('el login no muestra el bloque de créditos', async () => {
      const res = await require('supertest')(app).get('/login');
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/Co-asesoras|Alumna/);
    });
  });
});
