'use strict';

const crypto = require('node:crypto');

/** Hash FNV-1a de 32 bits: convierte una cadena en una semilla estable. */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Generador pseudoaleatorio determinístico (mulberry32). */
function seededRandom(seed) {
  let a = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value, decimals = 1) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function uuid() {
  return crypto.randomUUID();
}

/** Contraseña temporal legible (sin caracteres ambiguos) que cumple la política. */
function temporaryPassword() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 8; i += 1) out += letters[bytes[i] % letters.length];
  out += digits[bytes[8] % digits.length] + digits[bytes[9] % digits.length];
  return `${out}!`;
}

module.exports = { hashString, seededRandom, round, uuid, temporaryPassword };
