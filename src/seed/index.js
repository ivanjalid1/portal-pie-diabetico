'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEMO_PASSWORD, STAFF, PATIENTS, NOTAS } = require('./demoData');
const { ACQUISITION, CAPTURE_CHECKLIST, CONSENT_VERSION } = require('../config/domain');
const { seededRandom, round, uuid } = require('../utils/random');

const DEMO_DIR = path.join(__dirname, '..', '..', 'public', 'demo');
const DEMO_VARIANTS = 6;
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

  let imageIndex = 0;
  let nota = 0;
  for (const p of PATIENTS) {
    if (await repos.patients.findByCodigo(p.codigo)) continue;
    const medico = staff[p.medico];
    const { tomas, medico: _m, personal, hba1cDias, lesion, ...clinical } = p;
    const alta = daysAgo(now, (tomas[0]?.dias || 20) + 5, 8, 45);

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

    for (let i = 0; i < tomas.length; i += 1) {
      const t = tomas[i];
      const isLast = i === tomas.length - 1;
      const fecha = daysAgo(now, t.dias, 9 + Math.floor(rnd() * 3), Math.floor(rnd() * 4) * 15);
      const variant = (imageIndex % DEMO_VARIANTS) + 1;
      imageIndex += 1;
      const studyId = uuid();
      const images = await demoImages({ repos, patient, studyId, variant, upload: options.uploadImages });
      const publicado = t.publicado ?? true;

      const study = await repos.studies.create({
        id: studyId,
        patientId: patient.id,
        medicoId: medico.id,
        toma: i + 1,
        fechaHora: fecha.toISOString(),
        centro: p.centro,
        tempAmbiente: t.temp ?? round(21.6 + rnd() * 2, 1),
        humedadRelativa: t.humedad ?? Math.round(45 + rnd() * 18),
        distanciaCm: ACQUISITION.distanciaCm,
        emisividad: ACQUISITION.emisividad,
        rangoMin: ACQUISITION.rango.min,
        rangoMax: ACQUISITION.rango.max,
        paleta: 'Ironbow',
        tiempoEstabilizacionMin: 15,
        fondo: rnd() < 0.6 ? 'Cartulina' : 'Tela',
        valida: t.valida ?? true,
        motivoInvalidez: t.motivo || null,
        checklist: CAPTURE_CHECKLIST.map((c) => c.key),
        images,
        estado: 'analizado',
        notasMedico: rnd() < 0.7 ? NOTAS[nota++ % NOTAS.length] : '',
        publicado,
        publicadoAt: publicado ? new Date(fecha.getTime() + 3600000).toISOString() : null,
        createdAt: fecha.toISOString(),
      });
      const output = await predictor.predict({ patient, study, images: [] });
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
          detail: `${patient.codigo} toma ${study.toma}: ${analysis.probabilidad} % · grupo ${analysis.grupo} · ${analysis.predictorVersion}`,
        },
        new Date(fecha.getTime() + 60000),
      );

      // Toma 1 → control a ~40 días (toma 2); última toma → control a 6 semanas.
      const controlFecha = new Date(fecha.getTime() + (isLast ? 42 : 40) * DAY);
      await repos.appointments.create({
        patientId: patient.id,
        medicoId: medico.id,
        studyId: study.id,
        fecha: isoDate(controlFecha),
        motivo: isLast ? 'Control clínico y registro de desenlace' : 'Toma 2 · seguimiento termográfico',
        estado: isLast ? 'pendiente' : 'realizado',
        createdAt: fecha.toISOString(),
      });
    }
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

async function demoImages({ repos, patient, studyId, variant, upload }) {
  const n = String(variant).padStart(2, '0');
  const defs = [
    { slot: 'termografia', file: `termografia-${n}.png`, originalName: `IR_${1200 + variant * 7}.png` },
    { slot: 'visible', file: `visible-${n}.png`, originalName: `VIS_${1200 + variant * 7}.png` },
  ];
  const out = [];
  for (const d of defs) {
    const full = path.join(DEMO_DIR, d.file);
    const size = fs.existsSync(full) ? fs.statSync(full).size : 0;
    if (upload) {
      const buffer = fs.readFileSync(full);
      const { storagePath } = await repos.files.save({
        key: `${patient.id}/${studyId}/${d.slot}.png`,
        buffer,
        mime: 'image/png',
      });
      out.push({ slot: d.slot, storagePath, mime: 'image/png', size, originalName: d.originalName });
    } else {
      out.push({ slot: d.slot, publicUrl: `/demo/${d.file}`, mime: 'image/png', size, originalName: d.originalName });
    }
  }
  return out;
}

module.exports = { seedDemoData, DEMO_PASSWORD };
