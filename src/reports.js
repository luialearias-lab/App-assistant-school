'use strict';
const db = require('./db');
const { monthRange } = require('./time');

const EMPTY = () => ({ present: 0, late: 0, absent: 0, justified: 0, total: 0 });

function rate(c) {
  // Porcentaje de asistencia: presentes + tardanzas + justificadas sobre el total de clases.
  return c.total ? Math.round(((c.present + c.late + c.justified) / c.total) * 1000) / 10 : null;
}

/** Récord mensual de un alumno: totales, detalle por clase y resumen por curso. */
function studentMonth(studentId, month) {
  const range = monthRange(month);
  if (!range) return null;
  const d = db.get();
  const student = d.prepare(
    `SELECT st.id, st.first_name, st.last_name, st.document_id, st.guardian_name, st.guardian_phone,
            s.id AS section_id, s.name AS section_name, g.name AS grade_name
     FROM students st JOIN sections s ON s.id = st.section_id JOIN grades g ON g.id = s.grade_id WHERE st.id = ?`
  ).get(studentId);
  if (!student) return null;
  const records = d.prepare(
    `SELECT a.date, a.start_time, c.name AS course_name, c.id AS course_id, r.status, r.scanned_at, r.note
     FROM attendance_records r
     JOIN attendance_sessions a ON a.id = r.session_id
     JOIN courses c ON c.id = a.course_id
     WHERE r.student_id = ? AND a.date BETWEEN ? AND ?
     ORDER BY a.date, a.start_time`
  ).all(studentId, range.from, range.to);
  const totals = EMPTY();
  const byCourse = {};
  const byDay = {};
  for (const r of records) {
    totals[r.status]++;
    totals.total++;
    (byCourse[r.course_name] ||= EMPTY())[r.status]++;
    byCourse[r.course_name].total++;
    (byDay[r.date] ||= []).push(r.status);
  }
  for (const c of Object.values(byCourse)) c.rate = rate(c);
  totals.rate = rate(totals);
  return { month, student, totals, by_course: byCourse, by_day: byDay, records };
}

/** Récord mensual de toda una sección (una fila por alumno). */
function sectionMonth(sectionId, month, courseId) {
  const range = monthRange(month);
  if (!range) return null;
  const d = db.get();
  const section = d.prepare(
    'SELECT s.id, s.name, g.name AS grade_name FROM sections s JOIN grades g ON g.id = s.grade_id WHERE s.id = ?'
  ).get(sectionId);
  if (!section) return null;
  const students = d.prepare(
    'SELECT id, first_name, last_name FROM students WHERE section_id = ? AND active = 1 ORDER BY last_name, first_name'
  ).all(sectionId);
  const rows = d.prepare(
    `SELECT r.student_id, a.date, r.status FROM attendance_records r
     JOIN attendance_sessions a ON a.id = r.session_id JOIN courses c ON c.id = a.course_id
     WHERE c.section_id = ? AND a.date BETWEEN ? AND ? AND (? IS NULL OR c.id = ?)`
  ).all(sectionId, range.from, range.to, courseId ?? null, courseId ?? null);
  const map = new Map(students.map((s) => [s.id, { ...s, ...EMPTY(), days: {} }]));
  const dates = new Set();
  for (const r of rows) {
    const s = map.get(r.student_id);
    if (!s) continue;
    s[r.status]++;
    s.total++;
    dates.add(r.date);
    // Por día se muestra el peor estado: ausente > tarde > justificado > presente.
    const order = { absent: 3, late: 2, justified: 1, present: 0 };
    if (!(r.date in s.days) || order[r.status] > order[s.days[r.date]]) s.days[r.date] = r.status;
  }
  const list = [...map.values()].map((s) => ({ ...s, rate: rate(s) }));
  return { month, section, dates: [...dates].sort(), students: list };
}

function toCsv(report) {
  const head = ['Apellidos', 'Nombres', ...report.dates.map((d) => d.slice(8)), 'Presente', 'Tarde', 'Falta', 'Justificada', 'Total', '% Asistencia'];
  const code = { present: 'P', late: 'T', absent: 'F', justified: 'J' };
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head.map(esc).join(',')];
  for (const s of report.students) {
    lines.push([s.last_name, s.first_name, ...report.dates.map((d) => code[s.days[d]] || ''), s.present, s.late, s.absent, s.justified, s.total, s.rate ?? ''].map(esc).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

module.exports = { studentMonth, sectionMonth, toCsv };
