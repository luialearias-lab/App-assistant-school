'use strict';
const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const auth = require('../auth');
const { isValidTimeZone } = require('../time');
const { AppError } = require('../attendance');

const router = express.Router();
router.use(auth.requireAuth);

const int = (v) => (v === undefined || v === null || v === '' ? null : Number.parseInt(v, 10));
const str = (v) => (v === undefined || v === null ? null : String(v).trim() || null);
function required(obj, fields) {
  for (const f of fields) if (obj[f] === undefined || obj[f] === null || obj[f] === '') throw new AppError(400, `Falta el campo: ${f}`);
}
function unique(fn, msg) {
  try {
    return fn();
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new AppError(409, msg);
    if (/FOREIGN KEY/.test(e.message)) throw new AppError(409, 'No se puede eliminar: tiene registros asociados');
    throw e;
  }
}
const isTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t || '');

// ---------- Usuarios (docentes y administradores) ----------
router.get('/users', (req, res) => {
  const fields = req.user.role === 'admin' ? 'id, name, email, role, phone, created_at' : 'id, name, role';
  res.json(db.get().prepare(`SELECT ${fields} FROM users ORDER BY name`).all());
});

router.post('/users', auth.requireAdmin, (req, res) => {
  const b = req.body || {};
  required(b, ['name', 'email', 'password']);
  if (String(b.password).length < 6) throw new AppError(400, 'La contraseña debe tener al menos 6 caracteres');
  const role = b.role === 'admin' ? 'admin' : 'teacher';
  const r = unique(
    () => db.get().prepare('INSERT INTO users (name, email, password_hash, role, phone) VALUES (?, ?, ?, ?, ?)')
      .run(str(b.name), str(b.email), auth.hashPassword(b.password), role, str(b.phone)),
    'Ya existe un usuario con ese correo'
  );
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

router.put('/users/:id', auth.requireAdmin, (req, res) => {
  const b = req.body || {};
  const id = int(req.params.id);
  const u = db.get().prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new AppError(404, 'Usuario no encontrado');
  const role = b.role === 'admin' ? 'admin' : b.role === 'teacher' ? 'teacher' : u.role;
  if (u.role === 'admin' && role !== 'admin') {
    const admins = db.get().prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n;
    if (admins <= 1) throw new AppError(400, 'Debe existir al menos un administrador');
  }
  unique(() => db.get().prepare('UPDATE users SET name = ?, email = ?, role = ?, phone = ? WHERE id = ?')
    .run(str(b.name) || u.name, str(b.email) || u.email, role, b.phone !== undefined ? str(b.phone) : u.phone, id), 'Ya existe un usuario con ese correo');
  if (b.password) {
    if (String(b.password).length < 6) throw new AppError(400, 'La contraseña debe tener al menos 6 caracteres');
    db.get().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(b.password), id);
  }
  res.json({ ok: true });
});

router.delete('/users/:id', auth.requireAdmin, (req, res) => {
  const id = int(req.params.id);
  if (id === req.user.id) throw new AppError(400, 'No puede eliminar su propio usuario');
  db.get().prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- Grados ----------
router.get('/grades', (_req, res) => {
  res.json(db.get().prepare(
    `SELECT g.*, (SELECT COUNT(*) FROM sections s WHERE s.grade_id = g.id) AS sections
     FROM grades g ORDER BY g.sort_order, g.name`
  ).all());
});

router.post('/grades', auth.requireAdmin, (req, res) => {
  const b = req.body || {};
  required(b, ['name']);
  const r = unique(() => db.get().prepare('INSERT INTO grades (name, sort_order) VALUES (?, ?)').run(str(b.name), int(b.sort_order) || 0), 'Ya existe ese grado');
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

router.put('/grades/:id', auth.requireAdmin, (req, res) => {
  const b = req.body || {};
  required(b, ['name']);
  unique(() => db.get().prepare('UPDATE grades SET name = ?, sort_order = ? WHERE id = ?').run(str(b.name), int(b.sort_order) || 0, int(req.params.id)), 'Ya existe ese grado');
  res.json({ ok: true });
});

router.delete('/grades/:id', auth.requireAdmin, (req, res) => {
  unique(() => db.get().prepare('DELETE FROM grades WHERE id = ?').run(int(req.params.id)));
  res.json({ ok: true });
});

// ---------- Secciones ----------
router.get('/sections', (req, res) => {
  const gradeId = int(req.query.grade_id);
  res.json(db.get().prepare(
    `SELECT s.*, g.name AS grade_name, u.name AS tutor_name,
            (SELECT COUNT(*) FROM students st WHERE st.section_id = s.id AND st.active = 1) AS students
     FROM sections s JOIN grades g ON g.id = s.grade_id LEFT JOIN users u ON u.id = s.tutor_id
     WHERE (? IS NULL OR s.grade_id = ?) ORDER BY g.sort_order, g.name, s.name`
  ).all(gradeId, gradeId));
});

router.post('/sections', auth.requireAdmin, (req, res) => {
  const b = req.body || {};
  required(b, ['grade_id', 'name']);
  const r = unique(() => db.get().prepare('INSERT INTO sections (grade_id, name, tutor_id) VALUES (?, ?, ?)').run(int(b.grade_id), str(b.name), int(b.tutor_id)), 'Ya existe esa sección en el grado');
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

router.put('/sections/:id', auth.requireAdmin, (req, res) => {
  const b = req.body || {};
  required(b, ['grade_id', 'name']);
  unique(() => db.get().prepare('UPDATE sections SET grade_id = ?, name = ?, tutor_id = ? WHERE id = ?').run(int(b.grade_id), str(b.name), int(b.tutor_id), int(req.params.id)), 'Ya existe esa sección en el grado');
  res.json({ ok: true });
});

router.delete('/sections/:id', auth.requireAdmin, (req, res) => {
  unique(() => db.get().prepare('DELETE FROM sections WHERE id = ?').run(int(req.params.id)));
  res.json({ ok: true });
});

// ---------- Cursos ----------
router.get('/courses', (req, res) => {
  const sectionId = int(req.query.section_id);
  const mine = req.query.mine === '1' || req.user.role !== 'admin' ? req.user.id : null;
  res.json(db.get().prepare(
    `SELECT c.*, s.name AS section_name, g.name AS grade_name, g.id AS grade_id, u.name AS teacher_name
     FROM courses c JOIN sections s ON s.id = c.section_id JOIN grades g ON g.id = s.grade_id
     LEFT JOIN users u ON u.id = c.teacher_id
     WHERE (? IS NULL OR c.section_id = ?) AND (? IS NULL OR c.teacher_id = ?)
     ORDER BY g.sort_order, g.name, s.name, c.start_time, c.name`
  ).all(sectionId, sectionId, mine, mine));
});

function courseFields(b) {
  required(b, ['section_id', 'name', 'start_time']);
  if (!isTime(b.start_time)) throw new AppError(400, 'Hora de inicio inválida (HH:MM)');
  const tol = int(b.late_tolerance_min) ?? 10;
  const notify = int(b.notify_after_min) ?? 30;
  if (tol < 0 || notify < 0) throw new AppError(400, 'Los minutos no pueden ser negativos');
  if (notify < tol) throw new AppError(400, 'El tiempo para notificar debe ser mayor o igual a la tolerancia de tardanza');
  return [int(b.section_id), str(b.name), int(b.teacher_id), b.start_time, tol, notify];
}

router.post('/courses', auth.requireAdmin, (req, res) => {
  const f = courseFields(req.body || {});
  const r = unique(() => db.get().prepare(
    'INSERT INTO courses (section_id, name, teacher_id, start_time, late_tolerance_min, notify_after_min) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(...f), 'Ya existe ese curso en la sección');
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

router.put('/courses/:id', auth.requireAdmin, (req, res) => {
  const f = courseFields(req.body || {});
  unique(() => db.get().prepare(
    'UPDATE courses SET section_id = ?, name = ?, teacher_id = ?, start_time = ?, late_tolerance_min = ?, notify_after_min = ? WHERE id = ?'
  ).run(...f, int(req.params.id)), 'Ya existe ese curso en la sección');
  res.json({ ok: true });
});

router.delete('/courses/:id', auth.requireAdmin, (req, res) => {
  db.get().prepare('DELETE FROM courses WHERE id = ?').run(int(req.params.id));
  res.json({ ok: true });
});

// ---------- Alumnos ----------
const STUDENT_SQL = `
  SELECT st.*, s.name AS section_name, g.name AS grade_name, g.id AS grade_id
  FROM students st JOIN sections s ON s.id = st.section_id JOIN grades g ON g.id = s.grade_id`;

function newCodes() {
  return { qr: auth.randomCode(12), portal: auth.randomCode(10) };
}

router.get('/students', (req, res) => {
  const sectionId = int(req.query.section_id);
  const gradeId = int(req.query.grade_id);
  const courseId = int(req.query.course_id);
  const q = str(req.query.q);
  const inactive = req.query.inactive === '1' ? 1 : 0;
  let rows = db.get().prepare(
    `${STUDENT_SQL}
     WHERE (? IS NULL OR st.section_id = ?) AND (? IS NULL OR s.grade_id = ?)
       AND (? IS NULL OR st.section_id = (SELECT section_id FROM courses WHERE id = ?))
       AND (? IS NULL OR (st.first_name || ' ' || st.last_name || ' ' || COALESCE(st.document_id,'')) LIKE '%' || ? || '%')
       AND (st.active = 1 OR ? = 1)
     ORDER BY g.sort_order, g.name, s.name, st.last_name, st.first_name`
  ).all(sectionId, sectionId, gradeId, gradeId, courseId, courseId, q, q, inactive);
  if (req.user.role !== 'admin') rows = rows.map(({ qr_code, portal_code, ...r }) => r);
  res.json(rows);
});

router.get('/students/:id', (req, res) => {
  const st = db.get().prepare(`${STUDENT_SQL} WHERE st.id = ?`).get(int(req.params.id));
  if (!st) throw new AppError(404, 'Alumno no encontrado');
  if (req.user.role !== 'admin') {
    delete st.qr_code;
    delete st.portal_code;
  }
  res.json(st);
});

function studentFields(b) {
  required(b, ['first_name', 'last_name', 'section_id']);
  return [str(b.first_name), str(b.last_name), str(b.document_id), int(b.section_id), str(b.guardian_name), str(b.guardian_phone)];
}

router.post('/students', auth.requireAdmin, (req, res) => {
  const f = studentFields(req.body || {});
  const c = newCodes();
  const r = db.get().prepare(
    `INSERT INTO students (first_name, last_name, document_id, section_id, guardian_name, guardian_phone, qr_code, portal_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(...f, c.qr, c.portal);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

router.put('/students/:id', auth.requireAdmin, (req, res) => {
  const b = req.body || {};
  const f = studentFields(b);
  db.get().prepare(
    `UPDATE students SET first_name = ?, last_name = ?, document_id = ?, section_id = ?, guardian_name = ?, guardian_phone = ?, active = ?
     WHERE id = ?`
  ).run(...f, b.active === false || b.active === 0 ? 0 : 1, int(req.params.id));
  res.json({ ok: true });
});

router.delete('/students/:id', auth.requireAdmin, (req, res) => {
  // Se da de baja (no se borra) para conservar el historial de asistencia.
  db.get().prepare('UPDATE students SET active = 0 WHERE id = ?').run(int(req.params.id));
  res.json({ ok: true });
});

router.post('/students/:id/regenerate-qr', auth.requireAdmin, (req, res) => {
  db.get().prepare('UPDATE students SET qr_code = ? WHERE id = ?').run(auth.randomCode(12), int(req.params.id));
  res.json({ ok: true });
});

/** Importación masiva: una línea por alumno "Apellidos;Nombres;DNI;Apoderado;Teléfono". */
router.post('/students/import', auth.requireAdmin, (req, res) => {
  const { section_id, csv } = req.body || {};
  const sectionId = int(section_id);
  if (!db.get().prepare('SELECT id FROM sections WHERE id = ?').get(sectionId)) throw new AppError(400, 'Sección inválida');
  const lines = String(csv || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const ins = db.get().prepare(
    `INSERT INTO students (last_name, first_name, document_id, section_id, guardian_name, guardian_phone, qr_code, portal_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const errors = [];
  let created = 0;
  db.tx(() => {
    lines.forEach((line, i) => {
      const cols = line.split(line.includes(';') ? ';' : ',').map((c) => c.trim());
      if (i === 0 && /apellido/i.test(cols[0])) return; // cabecera
      if (!cols[0] || !cols[1]) {
        errors.push(`Línea ${i + 1}: faltan apellidos o nombres`);
        return;
      }
      const c = newCodes();
      ins.run(cols[0], cols[1], cols[2] || null, sectionId, cols[3] || null, cols[4] || null, c.qr, c.portal);
      created++;
    });
  });
  res.json({ created, errors });
});

router.get('/students/:id/qr.png', auth.requireAdmin, async (req, res) => {
  const st = db.get().prepare('SELECT qr_code FROM students WHERE id = ?').get(int(req.params.id));
  if (!st) throw new AppError(404, 'Alumno no encontrado');
  const png = await QRCode.toBuffer(`ASIS:${st.qr_code}`, { width: 400, margin: 2, errorCorrectionLevel: 'M' });
  res.type('png').send(png);
});

/** Datos para imprimir carnés con QR de una sección o de alumnos específicos. */
router.get('/qr-cards', auth.requireAdmin, async (req, res) => {
  const sectionId = int(req.query.section_id);
  const ids = String(req.query.ids || '').split(',').map((x) => int(x)).filter(Boolean);
  const rows = db.get().prepare(`${STUDENT_SQL} WHERE st.active = 1 AND (? IS NULL OR st.section_id = ?) ORDER BY st.last_name, st.first_name`)
    .all(sectionId, sectionId).filter((r) => !ids.length || ids.includes(r.id));
  const settings = db.getSettings();
  const base = settings.public_url || `${req.protocol}://${req.get('host')}`;
  const cards = await Promise.all(rows.map(async (r) => ({
    id: r.id,
    name: `${r.last_name}, ${r.first_name}`,
    grade: r.grade_name,
    section: r.section_name,
    document_id: r.document_id,
    qr: await QRCode.toDataURL(`ASIS:${r.qr_code}`, { width: 300, margin: 1, errorCorrectionLevel: 'M' }),
    portal_url: `${base.replace(/\/$/, '')}/portal.html?c=${r.portal_code}`,
  })));
  res.json({ school_name: settings.school_name, cards });
});

// ---------- Configuración ----------
const EDITABLE = ['school_name', 'timezone', 'public_url', 'notify_late', 'notify_absent', 'template_absent', 'template_late', 'template_message'];

router.get('/settings', auth.requireAdmin, (_req, res) => {
  const whatsapp = require('../whatsapp');
  res.json({ ...db.getSettings(), whatsapp_provider: whatsapp.provider() });
});

router.put('/settings', auth.requireAdmin, (req, res) => {
  const b = req.body || {};
  if (b.timezone !== undefined && !isValidTimeZone(b.timezone)) throw new AppError(400, 'Zona horaria inválida');
  for (const k of EDITABLE) if (b[k] !== undefined) db.setSetting(k, typeof b[k] === 'boolean' ? (b[k] ? '1' : '0') : b[k]);
  res.json(db.getSettings());
});

module.exports = router;
