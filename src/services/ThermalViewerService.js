'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { decodeIs2, extractVisible, hasVisible, is2Info } = require('../imaging/is2');
const { is2CaptureDate } = require('../imaging/pointwise');
const { decodePng, encodePng } = require('../imaging/png');
const { toCelsius, renderThermogram } = require('../imaging/thermogram');
const { encodeThermal, decodeThermal, grayToCelsius } = require('../imaging/thermalArray');
const { flagLabels } = require('../imaging/photoQuality');
const { NotFoundError } = require('../utils/errors');

const IS2_MIME = 'application/x-fluke-is2';

/**
 * Rutas del visor en el almacenamiento privado (bucket `estudios`, producción):
 * scripts/upload-visor-real.js sube la matriz (TPV1 comprimida con gzip), la
 * foto visible y un manifiesto por estudio. Ninguna empieza con el id del
 * paciente, así que las políticas de Storage del cliente no las alcanzan: sólo
 * el servidor (rol de servicio) las lee, después de verificar el acceso.
 */
const REMOTE = Object.freeze({
  manifest: (study) => `termica/${study.patientId}/${study.id}/visor.json`,
  thermal: (study, toma, rep) => `termica/${study.patientId}/${study.id}/toma${toma}-r${rep}.tpv`,
  visible: (study, toma, rep) => `visible/${study.patientId}/${study.id}/toma${toma}-r${rep}.jpg`,
});
const DEMO_RE = /par-(\d{2})-toma([12])\.png$/;
const DEMO_NAME_RE = /^TOMA([12])_par(\d{2})\.png$/i;

/**
 * Clave estable y no identificatoria de un archivo IS2: hash de su ruta
 * relativa a la carpeta privada (idéntica a scripts/lib/npy.js#is2Key).
 */
const is2Key = (root, file) =>
  crypto.createHash('sha1').update(path.relative(root, file).split(path.sep).join('/')).digest('hex').slice(0, 16);

/**
 * Datos del visor de termogramas (estilo Fluke SmartView): matriz de
 * temperaturas compacta (src/imaging/thermalArray.js) y, sólo en local con
 * datos reales, la foto visible completa del IS2 (el campo IR es su recorte
 * central, ver src/imaging/is2.js#FUSION).
 *
 * Fuentes por toma, en orden:
 *  1. réplicas reales exportadas (data-local/ml/cache, vía MaskService), una
 *     por archivo IS2 de la toma;
 *  2. un IS2 cargado en el estudio (cuentas → °C con la conversión del portal);
 *  3. el par demo público: la variante en grises de public/demo con la escala
 *     en °C de src/seed/demoImages.json (sin foto visible).
 *
 * PRIVACIDAD: la foto visible puede mostrar caras, el entorno o documentos.
 * Sólo se sirve si `privateDir` está definido (el contenedor lo define con
 * SEED=real, fuera de producción y de Vercel), se lee del IS2 en cada pedido
 * y nunca se escribe en disco.
 */
class ThermalViewerService {
  constructor({
    files = null,
    maskService = null,
    demoDir = null,
    demoManifest = null,
    privateDir = null,
    fotosDir = null,
  } = {}) {
    this.files = files;
    this.maskService = maskService;
    this.demoDir = demoDir;
    this.demoManifest = demoManifest;
    this.privateDir = privateDir && fs.existsSync(privateDir) ? privateDir : null;
    // Calidad automática por réplica (scripts/precompute-real.js → fotos.json).
    this.fotosDir = fotosDir;
    this._fotos = undefined;
    this._paths = null;
    this._cache = new Map();
  }

  /** Calidad automática por réplica (banderas, alineación, encuadre) o null. */
  fotos() {
    if (this._fotos === undefined) {
      this._fotos = null;
      const file = this.fotosDir ? path.join(this.fotosDir, 'fotos.json') : null;
      if (file && fs.existsSync(file)) {
        try {
          const f = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (f && f.replicas) this._fotos = f;
        } catch {
          // archivo ilegible: sin calidad automática
        }
      }
    }
    return this._fotos;
  }

  /**
   * Campos de calidad automática de una réplica para el visor: banderas en
   * lenguaje simple, desplazamiento de la foto (px de la foto, sólo si se
   * aplicó), encuadre de los pies (px IR) y giro sugerido para mostrar.
   */
  static viewerQuality(q) {
    if (!q) return { evaluada: false, enPromedio: false, avisos: [], alineacion: null, encuadre: null, giro: 0 };
    const al = q.alineacion;
    return {
      evaluada: true,
      // Réplica incluida en el promedio de la toma (src/imaging/replicaAverage.js).
      enPromedio: Boolean(q.enPromedio),
      avisos: flagLabels(q.banderas),
      alineacion: al && al.aplicada ? { dx: al.dxFoto, dy: al.dyFoto } : null,
      encuadre: Array.isArray(q.encuadre) && q.encuadre.length === 4 ? q.encuadre : null,
      giro: Number.isFinite(q.giro) ? q.giro : 0,
    };
  }

  /** ¿Se pueden mostrar fotos visibles? (sólo local con datos reales) */
  get visibleEnabled() {
    return Boolean(this.privateDir);
  }

  /** Mapa clave → ruta de los IS2 de la carpeta privada (se arma una vez). */
  is2Paths() {
    if (!this.privateDir) return new Map();
    if (!this._paths) {
      const out = new Map();
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (/\.is2$/i.test(e.name)) out.set(is2Key(this.privateDir, p), p);
        }
      };
      try {
        walk(this.privateDir);
      } catch {
        // carpeta ilegible: sin fotos
      }
      this._paths = out;
    }
    return this._paths;
  }

  memo(key, fn) {
    if (this._cache.has(key)) return this._cache.get(key);
    const v = fn();
    this._cache.set(key, v);
    if (this._cache.size > 32) this._cache.delete(this._cache.keys().next().value);
    return v;
  }

  /* ---------------- Réplicas reales (por clave) ---------------- */

  realEntries(codigo, toma) {
    if (!this.maskService?.enabled || !codigo) return [];
    return this.maskService
      .index()
      .filter((e) => e.codigo === codigo && e.toma === toma)
      .sort((a, b) => a.rep - b.rep);
  }

  /** Matriz binaria TPV1 de una réplica exportada. */
  thermalByKey(key) {
    if (!this.maskService?.enabled) throw new NotFoundError('Imagen no encontrada.');
    return this.memo(`k:${key}`, () => {
      const T = this.maskService.temperature(key);
      return encodeThermal({ width: 320, height: 240, data: T });
    });
  }

  hasVisibleKey(key) {
    return this.visibleEnabled && this.is2Paths().has(key);
  }

  /** Metadatos de captura no identificatorios de un IS2 (null si no se puede leer). */
  infoOf(buffer) {
    try {
      return { ...is2Info(buffer), fecha: is2CaptureDate(buffer) };
    } catch {
      return null;
    }
  }

  /** Metadatos de una réplica real (sólo con la carpeta privada local). */
  infoByKey(key) {
    if (!this.hasVisibleKey(key)) return null;
    return this.memo(`i:${key}`, () => this.infoOf(fs.readFileSync(this.is2Paths().get(key))));
  }

  /** Foto visible completa (JPEG 640 × 480) de una réplica; null si no hay. */
  visibleByKey(key) {
    if (!this.hasVisibleKey(key)) return null;
    const v = extractVisible(fs.readFileSync(this.is2Paths().get(key)));
    return v ? v.jpeg : null;
  }

  /* ---------------- Manifiesto remoto (producción) ---------------- */

  /** Manifiesto del visor subido al almacenamiento privado, o null. */
  async remoteManifest(study) {
    if (!this.files || !study?.patientId) return null;
    const key = `m:${study.id}`;
    if (this._cache.has(key)) return this._cache.get(key);
    let man;
    try {
      const buf = await this.files.read(REMOTE.manifest(study));
      man = buf ? JSON.parse(buf.toString('utf8')) : null;
    } catch {
      man = null;
    }
    this._cache.set(key, man);
    return man;
  }

  /* ---------------- Estudio ---------------- */

  demoOf(image) {
    if (!image) return null;
    let m = DEMO_RE.exec(image.publicUrl || '');
    let par;
    let toma;
    if (m) [, par, toma] = m;
    else if ((m = DEMO_NAME_RE.exec(image.originalName || ''))) [, toma, par] = m;
    else return null;
    const entry = this.demoManifest?.pares?.find((p) => p.par === Number(par));
    const t = entry?.[`toma${toma}`];
    if (!t?.escala || !this.demoDir) return null;
    const file = path.join(this.demoDir, t.file.replace('.png', '-grises.png'));
    return fs.existsSync(file) ? { file, escala: t.escala } : null;
  }

  /**
   * Fuentes del visor de un estudio (ya autorizado): por toma, sus réplicas.
   * Con `info: false` no lee los metadatos de captura de cada IS2 local
   * (página «Revisión de fotos», que lista cientos de réplicas).
   * @returns {Promise<Array<{toma:number, origen:string, reps:Array<{rep:number, calidad:number|null, mejor:boolean, foto:boolean, noValido:boolean}>}>>}
   */
  async sources(study, patient, { info: conInfo = true } = {}) {
    const out = [];
    const man = this.maskService?.enabled ? null : await this.remoteManifest(study);
    for (const toma of [1, 2]) {
      const image = study.image(`toma${toma}`);
      if (!image) continue;
      const real = this.realEntries(patient?.codigo, toma);
      const remota = man?.tomas?.find((x) => x.toma === toma);
      if (!real.length && remota?.reps?.length) {
        out.push({
          toma,
          origen: 'real',
          calidadBaja: Boolean(remota.calidadBaja),
          reps: remota.reps.map((r) => ({
            rep: r.rep,
            calidad: r.calidad ?? null,
            mejor: Boolean(r.mejor),
            noValido: Boolean(r.noValido),
            foto: Boolean(r.foto),
            info: r.info || null,
            // El manifiesto guarda los campos ya resueltos (scripts/upload-visor-real.js).
            evaluada: Boolean(r.evaluada),
            enPromedio: Boolean(r.enPromedio),
            avisos: Array.isArray(r.avisos) ? r.avisos : [],
            alineacion: r.alineacion || null,
            encuadre: Array.isArray(r.encuadre) ? r.encuadre : null,
            giro: Number.isFinite(r.giro) ? r.giro : 0,
          })),
        });
      } else if (real.length) {
        const fotos = this.fotos();
        const q = (e) => fotos?.replicas?.[e.key] || null;
        const validas = real.filter((e) => !e.noValido);
        // Con la calidad automática, la mejor es la elegida por el precálculo.
        const elegida = real.find((e) => q(e)?.elegida);
        const best =
          elegida || (validas.length ? validas : real).reduce((a, b) => ((b.calidad ?? 0) > (a.calidad ?? 0) ? b : a));
        const tq = fotos?.tomas?.[patient?.codigo]?.[toma] || null;
        out.push({
          toma,
          origen: 'real',
          calidadBaja: Boolean(tq?.baja),
          reps: real.map((e) => ({
            rep: e.rep + 1,
            calidad: q(e)?.calidad ?? e.calidad ?? null,
            mejor: e === best,
            noValido: Boolean(e.noValido),
            foto: this.hasVisibleKey(e.key),
            info: conInfo ? this.infoByKey(e.key) : null,
            ...ThermalViewerService.viewerQuality(q(e)),
          })),
        });
      } else if (image.mime === IS2_MIME && image.storagePath) {
        const buf = await this.files.read(image.storagePath);
        const info = buf ? this.infoOf(buf) : null;
        const foto = Boolean(this.visibleEnabled && buf && hasVisible(buf));
        // Fuera del modo local no se informa siquiera si el archivo trae foto.
        if (info && !this.visibleEnabled) info.visible = null;
        out.push({ toma, origen: 'is2', reps: [{ rep: 1, calidad: null, mejor: true, noValido: false, foto, info }] });
      } else if (this.demoOf(image)) {
        const info = { escalaPng: this.demoOf(image).escala };
        out.push({
          toma,
          origen: 'demo',
          reps: [{ rep: 1, calidad: null, mejor: true, noValido: false, foto: false, info }],
        });
      }
    }
    return out;
  }

  async resolve(study, patient, toma, rep) {
    const t = Number(toma);
    const r = Number(rep);
    if (![1, 2].includes(t) || !Number.isInteger(r) || r < 1 || r > 20)
      throw new NotFoundError('Imagen no encontrada.');
    const image = study.image(`toma${t}`);
    if (!image) throw new NotFoundError('Imagen no encontrada.');
    const real = this.realEntries(patient?.codigo, t);
    if (real.length) {
      const e = real.find((x) => x.rep + 1 === r);
      if (!e) throw new NotFoundError('Imagen no encontrada.');
      return { kind: 'real', key: e.key };
    }
    const man = this.maskService?.enabled ? null : await this.remoteManifest(study);
    const remota = man?.tomas?.find((x) => x.toma === t)?.reps?.find((x) => x.rep === r);
    if (remota) return { kind: 'remote', toma: t, rep: r, foto: Boolean(remota.foto) };
    if (r !== 1) throw new NotFoundError('Imagen no encontrada.');
    if (image.mime === IS2_MIME && image.storagePath) return { kind: 'is2', image };
    const demo = this.demoOf(image);
    if (demo) return { kind: 'demo', demo };
    throw new NotFoundError('Imagen no encontrada.');
  }

  /** Matriz binaria TPV1 de una toma/réplica del estudio. */
  async thermal(study, patient, toma, rep) {
    const src = await this.resolve(study, patient, toma, rep);
    if (src.kind === 'real') return this.thermalByKey(src.key);
    if (src.kind === 'remote') {
      const gz = await this.files.read(REMOTE.thermal(study, src.toma, src.rep));
      if (!gz) throw new NotFoundError('La imagen no está disponible.');
      return zlib.gunzipSync(gz);
    }
    if (src.kind === 'demo') {
      return this.memo(`d:${src.demo.file}`, () =>
        encodeThermal(grayToCelsius(decodePng(fs.readFileSync(src.demo.file)), src.demo.escala)),
      );
    }
    const buf = await this.files.read(src.image.storagePath);
    if (!buf) throw new NotFoundError('La imagen no está disponible.');
    return this.memo(`s:${src.image.storagePath}`, () => {
      const img = decodeIs2(buf);
      const data = new Float32Array(img.data.length);
      for (let i = 0; i < data.length; i += 1) data[i] = toCelsius(img.data[i]);
      return encodeThermal({ width: img.width, height: img.height, data });
    });
  }

  /**
   * Miniatura PNG de la térmica (página «Revisión de fotos»): escala fija de
   * la cámara (24–35 °C) y paleta High Contrast, como arranca el visor.
   */
  async thumbnail(study, patient, toma, rep, { width = 240, height = 180 } = {}) {
    const tpv = await this.thermal(study, patient, toma, rep);
    return this.memo(`t:${study.id}:${toma}:${rep}`, () => {
      const img = decodeThermal(tpv);
      const out = renderThermogram(img, { lo: 24, hi: 35, width, height });
      return encodePng(out.width, out.height, out.rgb);
    });
  }

  /**
   * Foto visible de una toma/réplica: local con datos reales (del IS2) o, en
   * producción, la subida al almacenamiento privado. Nunca en demo.
   */
  async visible(study, patient, toma, rep) {
    const src = await this.resolve(study, patient, toma, rep);
    let jpeg = null;
    if (src.kind === 'remote') {
      jpeg = src.foto ? await this.files.read(REMOTE.visible(study, src.toma, src.rep)) : null;
      if (!jpeg) throw new NotFoundError('Foto no disponible.');
      return jpeg;
    }
    if (!this.visibleEnabled) throw new NotFoundError('Foto no disponible.');
    if (src.kind === 'real') jpeg = this.visibleByKey(src.key);
    else if (src.kind === 'is2') {
      const buf = await this.files.read(src.image.storagePath);
      jpeg = buf ? extractVisible(buf)?.jpeg || null : null;
    }
    if (!jpeg) throw new NotFoundError('Foto no disponible.');
    return jpeg;
  }
}

module.exports = { ThermalViewerService, is2Key, REMOTE };
