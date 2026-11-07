'use strict';
// Utilidades de fecha/hora en la zona horaria configurada del colegio.
// Las fechas se manejan como cadenas locales 'YYYY-MM-DD' y 'HH:MM[:SS]',
// lo que permite comparar lexicográficamente sin depender de la TZ del servidor.

function parts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return p;
}

/** Devuelve { date: 'YYYY-MM-DD', time: 'HH:MM:SS', stamp: 'YYYY-MM-DD HH:MM:SS' } */
function localNow(timeZone, now = new Date()) {
  const p = parts(now, timeZone);
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}:${p.second}`;
  return { date, time, stamp: `${date} ${time}` };
}

/** Suma minutos a una fecha+hora local y devuelve 'YYYY-MM-DD HH:MM:SS'. */
function addMinutes(date, hhmm, minutes) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm + Number(minutes), 0));
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00`;
}

/** Estado de una marcación: 'present' si está dentro de la tolerancia, si no 'late'. */
function scanStatus(session, stamp) {
  const limit = addMinutes(session.date, session.start_time, session.late_tolerance_min);
  return stamp <= limit ? 'present' : 'late';
}

/** Momento a partir del cual se marcan ausentes y se notifica a los padres. */
function notifyDeadline(session) {
  return addMinutes(session.date, session.start_time, session.notify_after_min);
}

function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) return null;
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

module.exports = { localNow, addMinutes, scanStatus, notifyDeadline, monthRange, isValidTimeZone };
