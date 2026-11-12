'use strict';

const { z } = require('zod');

/** Constructores de campos para formularios HTML (todo llega como string). */

const empty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Casilla de verificación: presente ('on', 'true', '1') → true. */
const checkbox = () =>
  z.preprocess((v) => v === true || v === 'on' || v === 'true' || v === '1' || v === 'si', z.boolean());

/** Número obligatorio con rango; acepta coma decimal (es-AR). */
const number = (label, { min, max, int = false } = {}) => {
  let schema = z.number({ error: `${label}: ingresá un número.` });
  if (int) schema = schema.int(`${label}: debe ser un número entero.`);
  if (min !== undefined) schema = schema.min(min, `${label}: el mínimo es ${String(min).replace('.', ',')}.`);
  if (max !== undefined) schema = schema.max(max, `${label}: el máximo es ${String(max).replace('.', ',')}.`);
  return z.preprocess((v) => (empty(v) ? undefined : Number(String(v).replace(',', '.'))), schema);
};

/** Número opcional: vacío → null. */
const optionalNumber = (label, opts) =>
  z.preprocess((v) => (empty(v) ? null : v), z.union([z.null(), number(label, opts)]));

const text = (label, { min = 1, max = 120 } = {}) =>
  z
    .string({ error: `${label} es obligatorio.` })
    .trim()
    .min(min, min === 1 ? `${label} es obligatorio.` : `${label}: mínimo ${min} caracteres.`)
    .max(max, `${label}: máximo ${max} caracteres.`);

const optionalText = (max = 500) =>
  z.preprocess((v) => (empty(v) ? null : String(v).trim()), z.union([z.null(), z.string().max(max, `Máximo ${max} caracteres.`)]));

const email = () =>
  z
    .string({ error: 'El correo es obligatorio.' })
    .trim()
    .toLowerCase()
    .pipe(z.email('Ingresá un correo electrónico válido.'));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const date = (label, { notFuture = false } = {}) =>
  z
    .string({ error: `${label} es obligatoria.` })
    .trim()
    .regex(ISO_DATE, `${label}: fecha inválida.`)
    .refine((v) => !Number.isNaN(new Date(v).getTime()), `${label}: fecha inválida.`)
    .refine((v) => !notFuture || new Date(`${v}T00:00:00`) <= new Date(), `${label}: no puede ser futura.`);

const optionalDate = (label, opts) => z.preprocess((v) => (empty(v) ? null : v), z.union([z.null(), date(label, opts)]));

/** Lista de valores (checkboxes con el mismo nombre). */
const list = () => z.preprocess((v) => (empty(v) ? [] : Array.isArray(v) ? v : [v]), z.array(z.string()));

module.exports = { checkbox, number, optionalNumber, text, optionalText, email, date, optionalDate, list, empty };
