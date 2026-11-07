'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const reports = require('../reports');
const messages = require('../messages');
const { AppError } = require('../attendance');
const { localNow } = require('../time');

// ---------- Reportes (requiere sesión) ----------
const reportsRouter = express.Router();
reportsRouter.use(auth.requireAuth);

function assertSectionAccess(user, sectionId) {
  if (user.role === 'admin') return;
  const ok = db.get().prepare('SELECT 1 FROM courses WHERE section_id = ? AND teacher_id = ? UNION SELECT 1 FROM sections WHERE id = ? AND tutor_id = ?')
    .get(sectionId, user.id, sectionId, user.id);
  if (!ok) throw new AppError(403, 'No tiene acceso a esta sección');
}

const monthOf = (q) => q || localNow(db.getSettings().timezone).date.slice(0, 7);

reportsRouter.get('/student/:id', (req, res) => {
  const r = reports.studentMonth(Number(req.params.id), monthOf(req.query.month));
  if (!r) throw new AppError(404, 'Alumno o mes inválido');
  assertSectionAccess(req.user, r.student.section_id);
  res.json(r);
});

reportsRouter.get('/section/:id', (req, res) => {
  const sectionId = Number(req.params.id);
  assertSectionAccess(req.user, sectionId);
  const courseId = req.query.course_id ? Number(req.query.course_id) : null;
  const r = reports.sectionMonth(sectionId, monthOf(req.query.month), courseId);
  if (!r) throw new AppError(404, 'Sección o mes inválido');
  if (req.query.format === 'csv') {
    const name = `asistencia_${r.section.grade_name}_${r.section.name}_${r.month}.csv`.replace(/[^\w.-]+/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    return res.type('text/csv; charset=utf-8').send(reports.toCsv(r));
  }
  res.json(r);
});

// ---------- Mensajes y tareas ----------
const messagesRouter = express.Router();
messagesRouter.use(auth.requireAuth);
messagesRouter.get('/', (req, res) => res.json(messages.list(req.user, { kind: req.query.kind })));
messagesRouter.post('/', async (req, res) => res.status(201).json(await messages.create(req.user, req.body)));
messagesRouter.delete('/:id', (req, res) => {
  messages.remove(req.user, Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Portal de padres y alumnos (acceso con código, sin contraseña) ----------
const portalRouter = express.Router();
const portalHits = new Map();
portalRouter.get('/:code', (req, res) => {
  const now = Date.now();
  const hits = (portalHits.get(req.ip) || []).filter((t) => now - t < 60e3);
  hits.push(now);
  portalHits.set(req.ip, hits);
  if (hits.length > 60) return res.status(429).json({ error: 'Demasiadas solicitudes' });
  const code = String(req.params.code || '').toUpperCase();
  const st = db.get().prepare('SELECT id FROM students WHERE portal_code = ? AND active = 1').get(code);
  if (!st) return res.status(404).json({ error: 'Código no válido' });
  const r = reports.studentMonth(st.id, monthOf(req.query.month));
  if (!r) return res.status(400).json({ error: 'Mes inválido' });
  const { guardian_phone, ...student } = r.student;
  res.json({
    school_name: db.getSettings().school_name,
    ...r,
    student,
    messages: messages.forStudent(st.id),
  });
});

module.exports = { reportsRouter, messagesRouter, portalRouter };
