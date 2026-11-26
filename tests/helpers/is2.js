'use strict';

/**
 * Genera un archivo .IS2 SINTÉTICO para las pruebas: un ZIP (sin compresión)
 * con Images/Main/IR.data de 320×241 uint16 (la primera fila es cabecera),
 * con dos "pies" más calientes que el fondo. `asym` agrega calor al pie
 * derecho del paciente (a la derecha de la imagen) en el dedo mayor.
 */
const { crc32 } = require('../../src/imaging/png');

function irData({ asym = 0 } = {}) {
  const W = 320;
  const H = 240;
  const buf = Buffer.alloc(W * 2 + W * H * 2);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let v = 4200 + ((x * 7 + y * 13) % 11);
      const inFoot = (cx) => ((x - cx) / 32) ** 2 + ((y - 125) / 95) ** 2 <= 1;
      if (inFoot(100)) v = 4850 + ((x + y) % 9);
      if (inFoot(220)) {
        v = 4850 + ((x * 3 + y) % 9);
        if (asym && y < 60 && x < 220) v += asym;
      }
      buf.writeUInt16LE(v, W * 2 + (y * W + x) * 2);
    }
  }
  return buf;
}

function zipStored(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** Campo protobuf: f32 (tipo 5) o bytes (tipo 2). */
function gpb(field, value) {
  const varint = (n) => {
    const out = [];
    do {
      let b = n & 127;
      n >>>= 7;
      if (n) b |= 128;
      out.push(b);
    } while (n);
    return Buffer.from(out);
  };
  if (Buffer.isBuffer(value)) return Buffer.concat([varint((field << 3) | 2), varint(value.length), value]);
  const f = Buffer.alloc(4);
  f.writeFloatLE(value);
  return Buffer.concat([varint((field << 3) | 5), f]);
}

/** Foto «visible» sintética de 640 × 480 (JPEG, gris liso con un rectángulo claro). */
function visibleJpeg() {
  const jpeg = require('jpeg-js');
  const W = 640;
  const H = 480;
  const data = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const v = x > 200 && x < 440 && y > 150 && y < 330 ? 220 : 60;
      data.set([v, v, v, 255], (y * W + x) * 4);
    }
  }
  return Buffer.from(jpeg.encode({ data, width: W, height: H }, 70).data);
}

/**
 * @param {{ asym?: number, visible?: boolean }} [opts] `visible` agrega la foto
 *   visible (Images/Main/028001E0.jpg) y los metadatos de captura en protobuf.
 */
function fakeIs2(opts = {}) {
  const entries = [
    ['CameraInfo.gpbenc', opts.visible ? gpb(23, Buffer.from('TiS75-00000000')) : Buffer.from('demo')],
    ['Images/Main/IR.data', irData(opts)],
  ];
  if (opts.visible) {
    const escala = Buffer.concat([gpb(6, 24), gpb(7, 35)]);
    entries.push([
      'Images/Main/IRImageInfo.gpbenc',
      Buffer.concat([gpb(10, 0.97), gpb(11, 22), gpb(12, 1), gpb(14, escala)]),
    ]);
    entries.push(['Images/Main/028001E0.jpg', visibleJpeg()]);
  }
  return zipStored(entries);
}

module.exports = { fakeIs2, gpb };
