'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEMO_PASSWORD, STAFF, PATIENTS, NOTAS } = require('./demoData');
const { pares: DEMO_PAIRS } = require('./demoImages.json');
const { ACQUISITION, CAPTURE_CHECKLIST, CONSENT_VERSION } = require('../config/domain');
const { seededRandom, round, uuid } = require('../utils/random');

const DEMO_DIR = path.join(__dirname, '..', '..', 'public', 'demo');
const DAY = 86400000;

function daysAgo(now, days, hour = 9, minute = 30) {
  const d = new Date(now.getTime() - days * DAY);
  d.setHours(hour, minute, 0, 0);
  return d;
}

const isoDate = (d) => d.toISOString().slice(0, 10);

/**
 * Carga los datos de demostración usando exclusivamente los contratos de
 * repositorio, por lo que sirve tanto para el driver `memory` (en cada
 * arranque) como para `supabase` (script `npm run seed:supabase`).
 *
 * @param {object} deps  `{ repos, authProvider, predictor }` del driver activo.
 * @param {object} [options]
 * @param {boolean} [options.uploadImages] Sube las imágenes demo al FileStorage
 *   en lugar de servirlas como archivos estáticos de /public/demo.
 * @param {string}  [options.passwordHash] Hash bcrypt precomputado (driver memory).
 * @param {(msg: string) => void} [options.log]
 */
async function seedDemoData({ repos, authProvider, predictor }, options = {}) {
  const now = options.now || new Date();
  const log = options.log || (() => {});
  const rnd = seededRandom('termopie-seed');
  const staff = {};

  async function identity(email) {
    if (options.passwordHash && repos.credentials) {
      const id = uuid();
      repos.credentials.set(id, options.passwordHash);
      return id;
    }
    return authProvider.createIdentity(email, DEMO_PASSWORD, {});
  }

  const audit = (entry, at) => repos.audit.create({ ...entry, createdAt: at.toISOString() });

  for (const s of STAFF) {
    const { key, ...profile } = s;
    const existing = await repos.users.findByEmail(s.email);
    if (existing) {
      staff[key] = existing;
      continue;
    }
    const id = await identity(s.email);
    staff[key] = await repos.users.create({
      ...profile,
      id,
      activo: true,
      mustChangePassword: false,
      createdAt: daysAgo(now, 200).toISOString(),
    });
    log(`usuario ${s.email}`);
  }
  await audit(
    { actorEmail: 'sistema', action: 'user.created', entity: 'usuario', detail: 'Carga inicial de cuentas' },
    daysAgo(now, 200, 8, 0),
  );

  let nota = 0;
  for (const p of PATIENTS) {
    if (await repos.patients.findByCodigo(p.codigo)) continue;
    const medico = staff[p.medico];
    const { estudio, medico: _m, personal, hba1cDias, lesion, ...clinical } = p;
    const diasToma1 = estudio ? estudio.dias + estudio.intervalo : 33;
    const alta = daysAgo(now, diasToma1 + 1, 8, 45);

    const userId = await identity(personal.email);
    const user = await repos.users.create({
      ...personal,
      id: userId,
      role: 'paciente',
      institucion: p.centro,
      activo: true,
      mustChangePassword: false,
      createdAt: alta.toISOString(),
    });

    const patient = await repos.patients.create({
      ...clinical,
      userId: user.id,
      medicoId: medico.id,
      hba1cFecha: hba1cDias ? isoDate(daysAgo(now, hba1cDias)) : null,
      consentimientoFirmado: true,
      consentimientoFecha: isoDate(alta),
      lesionFecha: lesion ? isoDate(daysAgo(now, lesion.dias)) : null,
      lesionPie: lesion?.pie || null,
      lesionRoi: lesion?.roi || null,
      lesionNotas: lesion ? 'Lesión confirmada en el control clínico de seguimiento.' : null,
      cirugiasPrevias: p.ulceraPreviaDer || p.ulceraPreviaIzq ? 'Desbridamiento de úlcera plantar previa' : null,
      createdAt: alta.toISOString(),
    });
    await repos.consents.create({
      patientId: patient.id,
      version: CONSENT_VERSION,
      fechaFirma: isoDate(alta),
      registradoPor: medico.id,
      notas: 'Firmado en papel; original archivado en la historia clínica.',
      createdAt: alta.toISOString(),
    });
    await audit(
      {
        actorId: medico.id,
        actorEmail: medico.email,
        action: 'patient.created',
        entity: 'paciente',
        entityId: patient.id,
        detail: `${patient.codigo} · cuenta de paciente creada`,
      },
      alta,
    );
    log(`paciente ${patient.codigo}`);

    if (!estudio) {
      // Paciente con la toma 1 agendada pero todavía sin estudio comparativo.
      await repos.appointments.create({
        patientId: patient.id,
        medicoId: medico.id,
        fecha: isoDate(new Date(now.getTime() + 5 * DAY)),
        motivo: 'Toma 2 · control termográfico',
        estado: 'pendiente',
        createdAt: alta.toISOString(),
      });
      continue;
    }

    const pair = DEMO_PAIRS.find((x) => x.par === estudio.par);
    const fechaToma1 = daysAgo(now, diasToma1, 9, 15);
    const fecha = daysAgo(now, estudio.dias, 9 + Math.floor(rnd() * 3), Math.floor(rnd() * 4) * 15);
    const studyId = uuid();
    const images = await demoImages({ repos, patient, studyId, pair, upload: options.uploadImages });
    const publicado = estudio.publicado ?? true;

    const study = await repos.studies.create({
      id: studyId,
      patientId: patient.id,
      medicoId: medico.id,
      fechaHora: fecha.toISOString(),
      fechaToma1: fechaToma1.toISOString(),
      centro: p.centro,
      tempAmbiente: estudio.temp ?? round(21.6 + rnd() * 2, 1),
      humedadRelativa: estudio.humedad ?? Math.round(45 + rnd() * 18),
      tempAmbienteToma1: round(21.8 + rnd() * 1.8, 1),
      humedadRelativaToma1: Math.round(46 + rnd() * 16),
      distanciaCm: ACQUISITION.distanciaCm,
      emisividad: ACQUISITION.emisividad,
      rangoMin: ACQUISITION.rango.min,
      rangoMax: ACQUISITION.rango.max,
      paleta: 'Ironbow',
      tiempoEstabilizacionMin: 15,
      fondo: rnd() < 0.6 ? 'Cartulina' : 'Tela',
      valida: estudio.valida ?? true,
      motivoInvalidez: estudio.motivo || null,
      checklist: CAPTURE_CHECKLIST.map((c) => c.key),
      images,
      estado: 'analizado',
      notasMedico: rnd() < 0.7 ? NOTAS[nota++ % NOTAS.length] : '',
      publicado,
      publicadoAt: publicado ? new Date(fecha.getTime() + 3600000).toISOString() : null,
      createdAt: fecha.toISOString(),
    });
    const output = await predictor.predict({
      patient,
      study,
      images: [],
      hints: { toma1: pair.toma1.rois, toma2: pair.toma2.rois, fuente: 'imagen' },
    });
    const analysis = await repos.analyses.create({
      ...output,
      studyId: study.id,
      createdAt: new Date(fecha.getTime() + 60000).toISOString(),
    });
    await audit(
      {
        actorId: medico.id,
        actorEmail: medico.email,
        action: 'analysis.completed',
        entity: 'estudio',
        entityId: study.id,
        detail: `${patient.codigo}: ${analysis.probabilidad} % · grupo ${analysis.grupoToma1}→${analysis.grupo} · ${analysis.predictorVersion}`,
      },
      new Date(fecha.getTime() + 60000),
    );

    // Toma 2 realizada (agendada en la toma 1) y control clínico a 6 semanas.
    await repos.appointments.create({
      patientId: patient.id,
      medicoId: medico.id,
      fecha: isoDate(fecha),
      motivo: 'Toma 2 · control termográfico',
      estado: 'realizado',
      createdAt: fechaToma1.toISOString(),
    });
    await repos.appointments.create({
      patientId: patient.id,
      medicoId: medico.id,
      studyId: study.id,
      fecha: isoDate(new Date(fecha.getTime() + 42 * DAY)),
      motivo: 'Control clínico y registro de desenlace',
      estado: 'pendiente',
      createdAt: fecha.toISOString(),
    });
  }

  await audit(
    {
      actorId: staff.medico.id,
      actorEmail: staff.medico.email,
      action: 'user.login',
      entity: 'usuario',
      entityId: staff.medico.id,
      detail: 'Rol: medico',
    },
    daysAgo(now, 1, 8, 12),
  );
  return staff;
}

async function demoImages({ repos, patient, studyId, pair, upload }) {
  const out = [];
  for (const slot of ['toma1', 'toma2']) {
    const file = pair[slot].file;
    const full = path.join(DEMO_DIR, file);
    const size = fs.existsSync(full) ? fs.statSync(full).size : 0;
    const originalName = `${slot === 'toma1' ? 'TOMA1' : 'TOMA2'}_par${String(pair.par).padStart(2, '0')}.png`;
    if (upload) {
      const buffer = fs.readFileSync(full);
      const { storagePath } = await repos.files.save({
        key: `${patient.id}/${studyId}/${slot}.png`,
        buffer,
        mime: 'image/png',
      });
      out.push({ slot, storagePath, mime: 'image/png', size, originalName });
    } else {
      out.push({ slot, publicUrl: `/demo/${file}`, mime: 'image/png', size, originalName });
    }
  }
  return out;
}

module.exports = { seedDemoData, DEMO_PASSWORD };
