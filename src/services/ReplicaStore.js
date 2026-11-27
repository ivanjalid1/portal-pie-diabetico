'use strict';

const zlib = require('node:zlib');

/**
 * Datos de análisis de CADA réplica (foto) de cada toma de los estudios
 * reales: grillas canónicas por pie, TCI, calidad de registro, marco y banderas
 * de calidad (scripts/precompute-real.js → `porReplica`). Con ellos, elegir
 * otra foto en «Revisión de fotos» vuelve a analizar esa toma sin reprocesar
 * los IS2.
 *
 * Fuentes, en orden:
 *  1. el dataset local (driver memory con SEED=real), por código de paciente;
 *  2. en producción, `termica/<paciente>/<estudio>/replicas.json.gz` en el
 *     almacenamiento PRIVADO (scripts/seed-supabase-real.js --actualizar). La
 *     ruta no empieza con el id del paciente: sólo la lee el servidor.
 *
 * Cada entrada trae también `storagePath`: la imagen PNG de esa réplica para
 * la toma del estudio (local: el montaje `real/`; producción: el bucket).
 */
const REMOTE_REPLICAS = Object.freeze({
  file: (study) => `termica/${study.patientId}/${study.id}/replicas.json.gz`,
  image: (study, toma, rep) => `${study.patientId}/${study.id}/toma${toma}-r${rep}.png`,
});

const campos = (r) => ({
  rep: Number(r.rep),
  clave: r.clave ?? null,
  izq: r.izq,
  der: r.der,
  tci: r.tci ?? null,
  calidad: r.calidad ?? null,
  puntaje: r.puntaje ?? null,
  banderas: Array.isArray(r.banderas) ? r.banderas : [],
  segmentacion: r.segmentacion ?? null,
  marco: r.marco ?? null,
  // Contorno automático (RLE 320 × 240) con el que se calcularon las grillas.
  mascara: typeof r.mascara === 'string' ? r.mascara : null,
});

class ReplicaStore {
  /**
   * @param {{dataset?: object|null, files?: object|null}} deps
   *   `dataset`: resultado del precálculo (sólo con el driver memory y SEED=real);
   *   `files`: FileStorage para leer el archivo remoto.
   */
  constructor({ dataset = null, files = null } = {}) {
    this.files = files;
    this.local = new Map();
    for (const p of dataset?.pacientes || []) {
      const tomas = {};
      for (const t of p.tomas || []) {
        if (t.ok && Array.isArray(t.porReplica) && t.porReplica.length) {
          tomas[t.toma] = t.porReplica.map((r) => ({
            ...campos(r),
            storagePath: r.imagen ? `real/${r.imagen}` : null,
          }));
        }
      }
      if (Object.keys(tomas).length) this.local.set(p.codigo, tomas);
    }
    this._cache = new Map();
  }

  /**
   * Réplicas con datos de análisis de un estudio ya autorizado.
   * @returns {Promise<null|Record<number, Array<object>>>} toma → réplicas (ordenadas por número)
   */
  async forStudy(study, patient) {
    if (patient?.codigo && this.local.has(patient.codigo)) return this.local.get(patient.codigo);
    if (!this.files || !study?.patientId) return null;
    const key = study.id;
    if (this._cache.has(key)) return this._cache.get(key);
    let out = null;
    try {
      const gz = await this.files.read(REMOTE_REPLICAS.file(study));
      const json = gz ? JSON.parse(zlib.gunzipSync(gz).toString('utf8')) : null;
      if (json?.tomas) {
        out = {};
        for (const [toma, reps] of Object.entries(json.tomas)) {
          out[Number(toma)] = reps
            .map((r) => ({ ...campos(r), storagePath: REMOTE_REPLICAS.image(study, Number(toma), Number(r.rep)) }))
            .sort((a, b) => a.rep - b.rep);
        }
      }
    } catch {
      out = null;
    }
    this._cache.set(key, out);
    if (this._cache.size > 16) this._cache.delete(this._cache.keys().next().value);
    return out;
  }

  /** Entrada de una réplica (toma, número) o null. */
  async replica(study, patient, toma, rep) {
    const all = await this.forStudy(study, patient);
    return all?.[Number(toma)]?.find((r) => r.rep === Number(rep)) || null;
  }

  /** Contenido del archivo remoto de un estudio (scripts/seed-supabase-real.js). */
  static remoteFile(porToma) {
    const tomas = {};
    for (const [toma, reps] of Object.entries(porToma)) {
      tomas[toma] = reps.map((r) => campos(r));
    }
    return zlib.gzipSync(Buffer.from(JSON.stringify({ version: 1, tomas })), { level: 9 });
  }
}

module.exports = { ReplicaStore, REMOTE_REPLICAS };
