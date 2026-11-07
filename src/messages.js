'use strict';
// Comentarios y tareas que el profesor envía a un grupo de alumnos.
const db = require('./db');
const whatsapp = require('./whatsapp');
const { localNow } = require('./time');
const { AppError } = require('./attendance');

/** Devuelve los IDs de alumnos destinatarios según el tipo de destino. */
function resolveRecipients(targetType, targetId, studentIds) {
  const d = db.get();
  switch (targetType) {
    case 'grade':
      return d.prepare('SELECT st.id FROM students st JOIN sections s ON s.id = st.section_id WHERE s.grade_id = ? AND st.active = 1').all(targetId).map((r) => r.id);
    case 'section':
      return d.prepare('SELECT id FROM students WHERE section_id = ? AND active = 1').all(targetId).map((r) => r.id);
    case 'course':
      return d.prepare('SELECT st.id FROM students st JOIN courses c ON c.section_id = st.section_id WHERE c.id = ? AND st.active = 1').all(targetId).map((r) => r.id);
    case 'students': {
      const ids = [...new Set((studentIds || []).map(Number).filter(Boolean))];
      if (!ids.length) return [];
      return d.prepare(`SELECT id FROM students WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.id);
    }
    default:
      throw new AppError(400, 'Destino inválido');
  }
}

/** Un docente solo puede escribir a alumnos de las secciones donde dicta algún curso. */
function assertTeacherScope(user, recipientIds) {
  if (user.role === 'admin' || !recipientIds.length) return;
  const allowed = new Set(db.get().prepare(
    'SELECT st.id FROM students st JOIN courses c ON c.section_id = st.section_id WHERE c.teacher_id = ?'
  ).all(user.id).map((r) => r.id));
  if (recipientIds.some((id) => !allowed.has(id))) {
    throw new AppError(403, 'Solo puede enviar mensajes a alumnos de las secciones donde dicta clases');
  }
}

function targetLabel(type, id) {
  const d = db.get();
  if (type === 'grade') return d.prepare('SELECT name FROM grades WHERE id = ?').get(id)?.name;
  if (type === 'section') {
    const r = d.prepare('SELECT g.name g, s.name s FROM sections s JOIN grades g ON g.id = s.grade_id WHERE s.id = ?').get(id);
    return r && `${r.g} "${r.s}"`;
  }
  if (type === 'course') {
    const r = d.prepare('SELECT c.name c, g.name g, s.name s FROM courses c JOIN sections s ON s.id = c.section_id JOIN grades g ON g.id = s.grade_id WHERE c.id = ?').get(id);
    return r && `${r.c} - ${r.g} "${r.s}"`;
  }
  return 'Alumnos seleccionados';
}

async function create(user, body) {
  const b = body || {};
  const kind = b.kind === 'task' ? 'task' : 'comment';
  const title = String(b.title || '').trim();
  const text = String(b.body || '').trim();
  if (!title || !text) throw new AppError(400, 'El título y el contenido son obligatorios');
  if (b.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.due_date)) throw new AppError(400, 'Fecha de entrega inválida');
  const targetType = b.target_type;
  const targetId = targetType === 'students' ? null : Number(b.target_id) || null;
  if (targetType !== 'students' && !targetId) throw new AppError(400, 'Seleccione el destino');
  const recipients = resolveRecipients(targetType, targetId, b.student_ids);
  if (!recipients.length) throw new AppError(400, 'No hay alumnos en el destino seleccionado');
  assertTeacherScope(user, recipients);

  const settings = db.getSettings();
  const sendWa = b.send_whatsapp ? 1 : 0;
  const id = db.tx((d) => {
    const r = d.prepare(
      `INSERT INTO messages (author_id, kind, title, body, due_date, target_type, target_id, send_whatsapp, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(user.id, kind, title, text, b.due_date || null, targetType, targetId, sendWa, localNow(settings.timezone).stamp);
    const mid = Number(r.lastInsertRowid);
    const ins = d.prepare('INSERT INTO message_recipients (message_id, student_id) VALUES (?, ?)');
    for (const sid of recipients) ins.run(mid, sid);
    return mid;
  });

  let whatsappResult = null;
  if (sendWa) {
    whatsappResult = { sent: 0, simulated: 0, failed: 0, skipped: 0 };
    const students = db.get().prepare(
      `SELECT s.* FROM students s JOIN message_recipients mr ON mr.student_id = s.id WHERE mr.message_id = ?`
    ).all(id);
    for (const st of students) {
      const msg = whatsapp.render(settings.template_message, {
        colegio: settings.school_name,
        tipo: kind === 'task' ? 'Tarea' : 'Comentario',
        alumno: `${st.first_name} ${st.last_name}`,
        apoderado: st.guardian_name || 'apoderado(a)',
        titulo: title,
        contenido: text,
        entrega: b.due_date ? `\nFecha de entrega: ${b.due_date.split('-').reverse().join('/')}` : '',
        profesor: user.name,
      });
      const r = await whatsapp.send({ studentId: st.id, phone: st.guardian_phone, body: msg, reason: kind === 'task' ? 'tarea' : 'comentario' });
      whatsappResult[r.status]++;
    }
  }
  return { id, recipients: recipients.length, whatsapp: whatsappResult };
}

function list(user, filters = {}) {
  const author = user.role === 'admin' ? null : user.id;
  const rows = db.get().prepare(
    `SELECT m.*, u.name AS author_name, (SELECT COUNT(*) FROM message_recipients r WHERE r.message_id = m.id) AS recipients
     FROM messages m LEFT JOIN users u ON u.id = m.author_id
     WHERE (? IS NULL OR m.author_id = ?) AND (? IS NULL OR m.kind = ?)
     ORDER BY m.id DESC LIMIT 300`
  ).all(author, author, filters.kind || null, filters.kind || null);
  return rows.map((m) => ({ ...m, target_label: targetLabel(m.target_type, m.target_id) }));
}

function remove(user, id) {
  const m = db.get().prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!m) throw new AppError(404, 'Mensaje no encontrado');
  if (user.role !== 'admin' && m.author_id !== user.id) throw new AppError(403, 'No puede eliminar este mensaje');
  db.get().prepare('DELETE FROM messages WHERE id = ?').run(id);
}

function forStudent(studentId) {
  return db.get().prepare(
    `SELECT m.id, m.kind, m.title, m.body, m.due_date, m.created_at, u.name AS author_name
     FROM messages m JOIN message_recipients r ON r.message_id = m.id LEFT JOIN users u ON u.id = m.author_id
     WHERE r.student_id = ? ORDER BY m.id DESC LIMIT 100`
  ).all(studentId);
}

module.exports = { create, list, remove, forStudent, resolveRecipients };
