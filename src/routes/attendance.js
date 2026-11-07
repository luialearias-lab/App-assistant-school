'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const att = require('../attendance');
const { localNow } = require('../time');

const router = express.Router();
router.use(auth.requireAuth);

/** Cursos del día para el usuario con el estado de su sesión de asistencia. */
router.get('/today', (req, res) => {
  const { timezone } = db.getSettings();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : localNow(timezone).date;
  const mine = req.user.role === 'admin' && req.query.mine !== '1' ? null : req.user.id;
  const rows = db.get().prepare(
    `SELECT c.id AS course_id, c.name AS course_name, c.start_time, c.late_tolerance_min, c.notify_after_min,
            s.id AS section_id, s.name AS section_name, g.name AS grade_name, u.name AS teacher_name,
            a.id AS session_id, a.status AS session_status,
            (SELECT COUNT(*) FROM students st WHERE st.section_id = s.id AND st.active = 1) AS total,
            (SELECT COUNT(*) FROM attendance_records r WHERE r.session_id = a.id AND r.status = 'present') AS present,
            (SELECT COUNT(*) FROM attendance_records r WHERE r.session_id = a.id AND r.status = 'late') AS late,
            (SELECT COUNT(*) FROM attendance_records r WHERE r.session_id = a.id AND r.status = 'absent') AS absent,
            (SELECT COUNT(*) FROM attendance_records r WHERE r.session_id = a.id AND r.status = 'justified') AS justified
     FROM courses c JOIN sections s ON s.id = c.section_id JOIN grades g ON g.id = s.grade_id
     LEFT JOIN users u ON u.id = c.teacher_id
     LEFT JOIN attendance_sessions a ON a.course_id = c.id AND a.date = ?
     WHERE (? IS NULL OR c.teacher_id = ?)
     ORDER BY c.start_time, g.sort_order, s.name`
  ).all(date, mine, mine);
  res.json({ date, courses: rows });
});

router.post('/sessions', (req, res) => {
  const { course_id, date } = req.body || {};
  const s = att.openSession(Number(course_id), req.user, date);
  res.json(att.roster(s.id));
});

router.get('/sessions/:id', (req, res) => {
  const r = att.roster(Number(req.params.id));
  if (!att.canManageCourse(req.user, r.session)) throw new att.AppError(403, 'No tiene permiso sobre este curso');
  res.json(r);
});

router.post('/sessions/:id/scan', async (req, res) => {
  const result = await att.scan(Number(req.params.id), (req.body || {}).code, req.user);
  res.json(result);
});

router.put('/sessions/:id/students/:studentId', async (req, res) => {
  const { status, note } = req.body || {};
  res.json(await att.setStatus(Number(req.params.id), Number(req.params.studentId), status, note, req.user));
});

/** Cierra la sesión ahora: marca ausentes y notifica a los padres. */
router.post('/sessions/:id/close', async (req, res) => {
  const s = att.getSession(Number(req.params.id));
  if (!att.canManageCourse(req.user, s)) throw new att.AppError(403, 'No tiene permiso sobre este curso');
  const r = await att.finalize(s.id);
  res.json({ ...att.roster(s.id), notified: r.notified });
});

router.post('/sessions/:id/reopen', (req, res) => {
  const s = att.getSession(Number(req.params.id));
  if (!att.canManageCourse(req.user, s)) throw new att.AppError(403, 'No tiene permiso sobre este curso');
  db.get().prepare("UPDATE attendance_sessions SET status = 'open', closed_at = NULL WHERE id = ?").run(s.id);
  // Elimina las faltas automáticas aún no notificadas para que puedan registrarse.
  db.get().prepare("DELETE FROM attendance_records WHERE session_id = ? AND method = 'auto' AND status = 'absent' AND notified_at IS NULL").run(s.id);
  res.json(att.roster(s.id));
});

/** Historial de notificaciones de WhatsApp. */
router.get('/notifications', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const studentFilter = req.user.role === 'admin' ? null : req.user.id;
  res.json(db.get().prepare(
    `SELECT n.*, st.first_name, st.last_name FROM notifications n
     LEFT JOIN students st ON st.id = n.student_id
     WHERE (? IS NULL OR st.section_id IN (SELECT section_id FROM courses WHERE teacher_id = ?))
     ORDER BY n.id DESC LIMIT ?`
  ).all(studentFilter, studentFilter, limit));
});

module.exports = router;
