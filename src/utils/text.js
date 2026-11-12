'use strict';

/** Normaliza texto para búsquedas: sin tildes y en minúsculas. */
function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

module.exports = { normalize };
