'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EVENTS } = require('../utils/eventBus');

/**
 * Registro local y persistente del «Desenlace real» (¿generó lesión?) que
 * carga el médico en el portal (patrón Observer: escucha OUTCOME_RECORDED).
 *
 * Por qué: con el driver `memory` (uso local con SEED=real) los cambios se
 * pierden al reiniciar el servidor. Este registro los guarda en
 * data-local/outcomes/outcomes.json (ignorada por git y Vercel), los vuelve a
 * aplicar al arrancar y es la fuente de scripts/ml/train-outcome.py para
 * entrenar, cuando haya casos suficientes, un modelo de úlcera real.
 *
 * Sólo se guarda lo necesario para entrenar: código del paciente (anónimo),
 * lesión sí/no, fecha, pie y zona. No se guardan nombres, documentos ni las
 * notas libres (pueden contener datos identificatorios).
 */
class OutcomeLog {
  constructor({ file, patients, events }) {
    this.file = file;
    this.patients = patients;
    this.events = events;
  }

  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(data?.registros) ? data.registros : [];
    } catch {
      return [];
    }
  }

  write(registros) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const doc = {
      _aviso: 'Desenlaces reales registrados en el portal (códigos anónimos). Local: no versionar.',
      actualizado: new Date().toISOString(),
      registros,
    };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Inserta o reemplaza el desenlace de un paciente (por código). */
  upsert(patient) {
    if (!patient?.codigo) return null;
    const reg = {
      codigo: patient.codigo,
      generoLesion:
        patient.generoLesion === null || patient.generoLesion === undefined ? null : Boolean(patient.generoLesion),
      fecha: patient.lesionFecha || null,
      pie: patient.lesionPie || null,
      zona: patient.lesionRoi || null,
      registrado: new Date().toISOString(),
    };
    const registros = this.read().filter((r) => r.codigo !== reg.codigo);
    registros.push(reg);
    registros.sort((a, b) => a.codigo.localeCompare(b.codigo));
    this.write(registros);
    return reg;
  }

  subscribe() {
    this.events.on(EVENTS.OUTCOME_RECORDED, async ({ entityId }) => {
      const p = await this.patients.findById(entityId);
      this.upsert(p);
    });
    return this;
  }

  /** Vuelve a aplicar los desenlaces guardados a los pacientes cargados (al arrancar). */
  async applyAll() {
    let n = 0;
    for (const r of this.read()) {
      const p = await this.patients.findByCodigo(r.codigo);
      if (!p) continue;
      await this.patients.update(p.id, {
        generoLesion: r.generoLesion,
        lesionFecha: r.fecha,
        lesionPie: r.pie,
        lesionRoi: r.zona,
      });
      n += 1;
    }
    return n;
  }
}

module.exports = OutcomeLog;
