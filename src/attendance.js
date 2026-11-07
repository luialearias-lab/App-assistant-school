'use strict';
// Lógica central de asistencia: apertura de sesiones, escaneo QR,
// cierre automático y notificación a los padres.
const db = require('./db');
const whatsapp = require('./whatsapp');
const { localNow, scanStatus, notifyDeadline } = require('./time');

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SESSION_SQL = `
  SELECT s.*, c.name AS course_name, c.section_id, c.teacher_id,
         sec.name AS section_name, g.name AS grade_name
  FROM attendance_sessions s
  JOIN courses c ON c.id = s.course_id
  JOIN sections sec ON sec.id = c.section_id
  JOIN grades g ON g.id = sec.grade_id`;

function getSession(id) {
  const s = db.get().prepare(`${SESSION_SQL} WHERE s.id = ?`).get(id);
  if (!s) throw new AppError(404, 'Sesión de asistencia no encontrada');
  return { ...s, deadline: notifyDeadline(s) };
}

function canManageCourse(user, course) {
  return user.role === 'admin' || course.teacher_id === user.id;
}

/** Abre (o recupera) la sesión de asistencia de un curso para una fecha. */
function openSession(courseId, user, date) {
  const d = db.get();
  const course = d.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
  if (!course) throw new AppError(404, 'Curso no encontrado');
  if (!canManageCourse(user, course)) throw new AppError(403, 'No tiene permiso sobre este curso');
  const { timezone } = db.getSettings();
  const day = date || localNow(timezone).date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new AppError(400, 'Fecha inválida');
  d.prepare(
    `INSERT OR IGNORE INTO attendance_sessions
       (course_id, date, start_time, late_tolerance_min, notify_after_min, opened_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(course.id, day, course.start_time, course.late_tolerance_min, course.notify_after_min, user.id);
  const row = d.prepare('SELECT id FROM attendance_sessions WHERE course_id = ? AND date = ?').get(course.id, day);
  return getSession(row.id);
}

/** Lista de alumnos de la sección con su estado en la sesión. */
function roster(sessionId) {
  const s = getSession(sessionId);
  const students = db.get().prepare(
    `SELECT st.id, st.first_name, st.last_name, st.guardian_name, st.guardian_phone,
            r.status, r.scanned_at, r.method, r.note, r.notified_at
     FROM students st
     LEFT JOIN attendance_records r ON r.student_id = st.id AND r.session_id = ?
     WHERE st.section_id = ? AND st.active = 1
     ORDER BY st.last_name, st.first_name`
  ).all(sessionId, s.section_id);
  const counts = { present: 0, late: 0, absent: 0, justified: 0, pending: 0 };
  for (const st of students) counts[st.status || 'pending']++;
  return { session: s, students, counts };
}

function templateVars(s, student, settings, stamp) {
  return {
    apoderado: student.guardian_name || 'apoderado(a)',
    alumno: `${student.first_name} ${student.last_name}`,
    grado: s.grade_name,
    seccion: s.section_name,
    curso: s.course_name,
    fecha: s.date.split('-').reverse().join('/'),
    hora: s.start_time,
    hora_registro: stamp ? stamp.slice(11, 16) : '',
    colegio: settings.school_name,
  };
}

/** Envía la notificación de ausencia o tardanza de un registro y lo marca como notificado. */
async function notifyRecord(s, recordId) {
  const d = db.get();
  const settings = db.getSettings();
  const r = d.prepare(
    `SELECT r.*, st.first_name, st.last_name, st.guardian_name, st.guardian_phone
     FROM attendance_records r JOIN students st ON st.id = r.student_id WHERE r.id = ?`
  ).get(recordId);
  if (!r || r.notified_at) return null;
  const enabled = r.status === 'absent' ? settings.notify_absent === '1' : r.status === 'late' ? settings.notify_late === '1' : false;
  // Se marca como notificado antes de enviar para evitar duplicados si el envío tarda.
  d.prepare('UPDATE attendance_records SET notified_at = ? WHERE id = ?').run(localNow(settings.timezone).stamp, r.id);
  if (!enabled) return null;
  const tpl = r.status === 'absent' ? settings.template_absent : settings.template_late;
  const body = whatsapp.render(tpl, templateVars(s, r, settings, r.scanned_at));
  return whatsapp.send({ studentId: r.student_id, phone: r.guardian_phone, body, reason: r.status === 'absent' ? 'ausencia' : 'tardanza' });
}

/** Registra la lectura del QR de un alumno. */
async function scan(sessionId, qrText, user, now = new Date()) {
  const s = getSession(sessionId);
  if (!canManageCourse(user, s)) throw new AppError(403, 'No tiene permiso sobre este curso');
  const code = String(qrText || '').trim().replace(/^ASIS:/i, '');
  const d = db.get();
  const student = d.prepare('SELECT * FROM students WHERE qr_code = ? AND active = 1').get(code);
  if (!student) throw new AppError(404, 'Código QR no reconocido');
  if (student.section_id !== s.section_id) {
    throw new AppError(409, `${student.first_name} ${student.last_name} no pertenece a ${s.grade_name} "${s.section_name}"`);
  }
  const { timezone } = db.getSettings();
  const local = localNow(timezone, now);
  if (local.date < s.date) throw new AppError(409, 'La sesión es de una fecha futura');
  const name = `${student.first_name} ${student.last_name}`;
  const existing = d.prepare('SELECT * FROM attendance_records WHERE session_id = ? AND student_id = ?').get(s.id, student.id);
  if (existing && existing.status !== 'absent') {
    return { result: 'duplicate', student: { id: student.id, name }, status: existing.status, scanned_at: existing.scanned_at };
  }
  const stamp = local.date > s.date ? `${s.date} 23:59:59` : local.stamp;
  const status = scanStatus(s, stamp);
  let recordId;
  if (existing) {
    // Estaba ausente (la sesión ya se cerró) y llegó después: pasa a tardanza.
    d.prepare("UPDATE attendance_records SET status = ?, scanned_at = ?, method = 'qr', notified_at = NULL WHERE id = ?").run(status, stamp, existing.id);
    recordId = existing.id;
  } else {
    const r = d.prepare("INSERT INTO attendance_records (session_id, student_id, status, scanned_at, method) VALUES (?, ?, ?, ?, 'qr')").run(s.id, student.id, status, stamp);
    recordId = Number(r.lastInsertRowid);
  }
  // Si ya pasó el plazo de notificación, la tardanza se avisa de inmediato.
  let notification = null;
  if (status === 'late' && stamp >= s.deadline) notification = await notifyRecord(s, recordId);
  return { result: 'ok', student: { id: student.id, name }, status, scanned_at: stamp, notification };
}

/** Cambio manual del estado de un alumno (p. ej. justificar una falta). */
async function setStatus(sessionId, studentId, status, note, user) {
  if (!['present', 'late', 'absent', 'justified'].includes(status)) throw new AppError(400, 'Estado inválido');
  const s = getSession(sessionId);
  if (!canManageCourse(user, s)) throw new AppError(403, 'No tiene permiso sobre este curso');
  const d = db.get();
  const student = d.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if (!student || student.section_id !== s.section_id) throw new AppError(404, 'Alumno no encontrado en la sección');
  const { timezone } = db.getSettings();
  const stamp = ['present', 'late'].includes(status) ? localNow(timezone).stamp : null;
  const existing = d.prepare('SELECT * FROM attendance_records WHERE session_id = ? AND student_id = ?').get(s.id, student.id);
  if (existing) {
    d.prepare("UPDATE attendance_records SET status = ?, note = ?, method = 'manual', scanned_at = COALESCE(scanned_at, ?) WHERE id = ?")
      .run(status, note ?? existing.note, stamp, existing.id);
  } else {
    d.prepare("INSERT INTO attendance_records (session_id, student_id, status, scanned_at, method, note, notified_at) VALUES (?, ?, ?, ?, 'manual', ?, NULL)")
      .run(s.id, student.id, status, stamp, note ?? null);
  }
  return roster(sessionId);
}

/**
 * Cierra la sesión: marca ausentes a los que no registraron asistencia
 * y envía WhatsApp a los padres de ausentes y tardanzas.
 */
async function finalize(sessionId) {
  const s = getSession(sessionId);
  const { timezone } = db.getSettings();
  const stamp = localNow(timezone).stamp;
  const pendingIds = db.tx((d) => {
    d.prepare(
      `INSERT OR IGNORE INTO attendance_records (session_id, student_id, status, method)
       SELECT ?, st.id, 'absent', 'auto' FROM students st WHERE st.section_id = ? AND st.active = 1`
    ).run(s.id, s.section_id);
    d.prepare("UPDATE attendance_sessions SET status = 'closed', closed_at = COALESCE(closed_at, ?) WHERE id = ?").run(stamp, s.id);
    return d.prepare("SELECT id FROM attendance_records WHERE session_id = ? AND status IN ('absent','late') AND notified_at IS NULL")
      .all(s.id).map((r) => r.id);
  });
  let sent = 0;
  for (const id of pendingIds) {
    const r = await notifyRecord(s, id);
    if (r) sent++;
  }
  return { session: getSession(sessionId), notified: sent };
}

/** Procesa las sesiones abiertas cuyo plazo de notificación ya venció. */
async function processDue(now = new Date()) {
  const { timezone } = db.getSettings();
  const stamp = localNow(timezone, now).stamp;
  const open = db.get().prepare("SELECT * FROM attendance_sessions WHERE status = 'open'").all();
  const results = [];
  for (const s of open) {
    if (notifyDeadline(s) <= stamp) results.push(await finalize(s.id));
  }
  return results;
}

module.exports = { AppError, getSession, openSession, roster, scan, setStatus, finalize, processDue, canManageCourse };
