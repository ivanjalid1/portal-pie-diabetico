'use strict';

/**
 * Helpers de presentación disponibles en todas las vistas EJS (`res.locals.fmt`).
 * Usan la configuración regional es-AR y zona horaria de Córdoba.
 */
const TZ = 'America/Argentina/Cordoba';

const dateFmt = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: TZ });
const dateLongFmt = new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
const dateTimeFmt = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: TZ,
});
const monthShortFmt = new Intl.DateTimeFormat('es-AR', { month: 'short', year: '2-digit', timeZone: TZ });

function toDate(v) {
  if (!v) return null;
  // Fechas "YYYY-MM-DD" se interpretan al mediodía para no correrse de día por la zona horaria.
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const fmt = {
  date(v) {
    const d = toDate(v);
    return d ? dateFmt.format(d) : '—';
  },
  dateLong(v) {
    const d = toDate(v);
    return d ? dateLongFmt.format(d) : '—';
  },
  dateTime(v) {
    const d = toDate(v);
    return d ? dateTimeFmt.format(d) : '—';
  },
  monthShort(v) {
    const d = toDate(v);
    return d ? monthShortFmt.format(d) : '—';
  },
  /** Valor para un <input type="date">. */
  inputDate(v) {
    const d = toDate(v);
    if (!d) return '';
    return d.toISOString().slice(0, 10);
  },
  /** Valor para un <input type="datetime-local"> en hora local de Córdoba. */
  inputDateTime(v) {
    const d = toDate(v) || new Date();
    const parts = new Intl.DateTimeFormat('sv-SE', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: TZ,
    }).format(d);
    return parts.replace(' ', 'T');
  },
  num(v, decimals = 1) {
    if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '—';
    return Number(v).toLocaleString('es-AR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  },
  signed(v, decimals = 1) {
    if (v === null || v === undefined) return '—';
    const n = Number(v);
    const s = fmt.num(Math.abs(n), decimals);
    if (n > 0) return `+${s}`;
    if (n < 0) return `−${s}`;
    return s;
  },
  pct(v, decimals = 0) {
    return `${fmt.num(v, decimals)} %`;
  },
  yesNo(v) {
    return v ? 'Sí' : 'No';
  },
  relativeDays(v, ref = new Date()) {
    const d = toDate(v);
    if (!d) return '';
    const days = Math.round((d.setHours(0, 0, 0, 0) - new Date(ref).setHours(0, 0, 0, 0)) / 86400000);
    if (days === 0) return 'hoy';
    if (days === 1) return 'mañana';
    if (days === -1) return 'ayer';
    if (days > 0) return `en ${days} días`;
    return `hace ${Math.abs(days)} días`;
  },
  bytes(n) {
    if (!n) return '0 KB';
    if (n < 1024 * 1024) return `${fmt.num(n / 1024, 0)} KB`;
    return `${fmt.num(n / (1024 * 1024), 1)} MB`;
  },
};

module.exports = { fmt, toDate, TZ };
