'use strict';

/**
 * Lectura y escritura mínima de archivos .npy (formato de NumPy, versión 1.0)
 * para intercambiar matrices con los scripts de Python de scripts/ml/ (y la
 * herramienta local de corrección de máscaras, src/services/MaskService.js).
 * Soporta float32 y uint8 en orden C.
 */
const fs = require('node:fs');
const path = require('node:path');

const DTYPES = {
  '<f4': { Ctor: Float32Array, bytes: 4 },
  '|u1': { Ctor: Uint8Array, bytes: 1 },
};

function writeNpy(file, data, shape) {
  const descr = data instanceof Float32Array ? '<f4' : data instanceof Uint8Array ? '|u1' : null;
  if (!descr) throw new Error('writeNpy: sólo Float32Array o Uint8Array');
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  const pre = 10;
  const total = Math.ceil((pre + header.length + 1) / 64) * 64;
  header = header.padEnd(total - pre - 1, ' ') + '\n';
  const head = Buffer.alloc(pre);
  head.write('\x93NUMPY', 0, 'latin1');
  head[6] = 1;
  head[7] = 0;
  head.writeUInt16LE(header.length, 8);
  const body = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([head, Buffer.from(header, 'latin1'), body]));
}

function readNpy(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('latin1', 1, 6) !== 'NUMPY') throw new Error(`${file}: no es .npy`);
  const major = buf[6];
  const hlen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
  const start = major === 1 ? 10 : 12;
  const header = buf.toString('latin1', start, start + hlen);
  const descr = /'descr':\s*'([^']+)'/.exec(header)[1];
  const shape = /'shape':\s*\(([^)]*)\)/
    .exec(header)[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const t = DTYPES[descr];
  if (!t) throw new Error(`${file}: dtype no soportado ${descr}`);
  const off = start + hlen;
  const n = shape.reduce((a, b) => a * b, 1);
  const copy = Buffer.from(buf.subarray(off, off + n * t.bytes));
  return { data: new t.Ctor(copy.buffer, copy.byteOffset, n), shape };
}

module.exports = { writeNpy, readNpy };
