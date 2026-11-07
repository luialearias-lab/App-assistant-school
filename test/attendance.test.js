'use strict';
const test = require('node:test');
const assert = require('node:assert');

process.env.WHATSAPP_PROVIDER = 'simulado';
const db = require('../src/db');
const auth = require('../src/auth');
const att = require('../src/attendance');
const reports = require('../src/reports');
const messages = require('../src/messages');
const { addMinutes, scanStatus, localNow } = require('../src/time');

// Convierte una hora local de Lima (UTC-5, sin horario de verano) a Date.
const lima = (stamp) => new Date(stamp.replace(' ', 'T') + '-05:00');

let teacher, other, admin, students, course;

test.before(() => {
  db.open(':memory:');
  db.setSetting('timezone', 'America/Lima');
  const d = db.get();
  const mk = (name, email, role) => ({ id: Number(d.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(name, email, auth.hashPassword('x'), role).lastInsertRowid), name, role });
  admin = mk('Admin', 'a@x', 'admin');
  teacher = mk('Profe', 't@x', 'teacher');
  other = mk('Otro', 'o@x', 'teacher');
  const g = Number(d.prepare("INSERT INTO grades (name) VALUES ('1ro')").run().lastInsertRowid);
  const s = Number(d.prepare("INSERT INTO sections (grade_id, name) VALUES (?, 'A')").run(g).lastInsertRowid);
  const s2 = Number(d.prepare("INSERT INTO sections (grade_id, name) VALUES (?, 'B')").run(g).lastInsertRowid);
  course = Number(d.prepare("INSERT INTO courses (section_id, name, teacher_id, start_time, late_tolerance_min, notify_after_min) VALUES (?, 'Matemática', ?, '08:00', 10, 30)").run(s, teacher.id).lastInsertRowid);
  const ins = d.prepare("INSERT INTO students (first_name, last_name, section_id, guardian_phone, qr_code, portal_code) VALUES (?, ?, ?, ?, ?, ?)");
  students = ['A', 'B', 'C', 'D'].map((n, i) => ({ id: Number(ins.run(n, 'Test', s, '987654321', 'QR' + n, 'P' + n).lastInsertRowid), qr: 'QR' + n }));
  ins.run('Z', 'Otra', s2, '987654321', 'QRZ', 'PZ');
});

test('utilidades de tiempo', () => {
  assert.strictEqual(addMinutes('2026-03-31', '23:50', 15), '2026-04-01 00:05:00');
  const s = { date: '2026-03-02', start_time: '08:00', late_tolerance_min: 10 };
  assert.strictEqual(scanStatus(s, '2026-03-02 08:10:00'), 'present');
  assert.strictEqual(scanStatus(s, '2026-03-02 08:10:01'), 'late');
  assert.strictEqual(localNow('America/Lima', new Date('2026-03-02T13:05:00Z')).stamp, '2026-03-02 08:05:00');
});

test('flujo completo de asistencia y notificación', async () => {
  const date = '2026-03-02';
  assert.throws(() => att.openSession(course, other, date), /permiso/);
  const s = att.openSession(course, teacher, date);
  assert.strictEqual(s.deadline, '2026-03-02 08:30:00');

  const r1 = await att.scan(s.id, 'ASIS:QRA', teacher, lima('2026-03-02 07:58:00'));
  assert.strictEqual(r1.status, 'present');
  const dup = await att.scan(s.id, 'QRA', teacher, lima('2026-03-02 08:01:00'));
  assert.strictEqual(dup.result, 'duplicate');
  const r2 = await att.scan(s.id, 'QRB', teacher, lima('2026-03-02 08:15:00'));
  assert.strictEqual(r2.status, 'late');
  assert.strictEqual(r2.notification, null, 'la tardanza se notifica al vencer el plazo');
  await assert.rejects(att.scan(s.id, 'QRZ', teacher, lima('2026-03-02 08:02:00')), /no pertenece/);
  await assert.rejects(att.scan(s.id, 'NOEXISTE', teacher), /no reconocido/);
  await att.setStatus(s.id, students[3].id, 'justified', 'Cita médica', teacher);

  // Antes del plazo no se procesa nada.
  assert.strictEqual((await att.processDue(lima('2026-03-02 08:29:00'))).length, 0);
  const done = await att.processDue(lima('2026-03-02 08:30:00'));
  assert.strictEqual(done.length, 1);
  assert.strictEqual(done[0].notified, 2); // B tarde + C ausente

  const { counts } = att.roster(s.id);
  assert.deepStrictEqual(counts, { present: 1, late: 1, absent: 1, justified: 1, pending: 0 });
  const notes = db.get().prepare('SELECT * FROM notifications ORDER BY id').all();
  assert.strictEqual(notes.length, 2);
  assert.ok(notes.every((n) => n.status === 'simulated' && n.phone === '51987654321'));
  assert.match(notes.find((n) => n.reason === 'ausencia').body, /C Test.*NO asistió.*Matemática/);

  // No se repiten notificaciones.
  assert.strictEqual((await att.processDue(lima('2026-03-02 09:00:00'))).length, 0);

  // Llega C después del cierre: pasa a tardanza y se notifica de inmediato.
  const late = await att.scan(s.id, 'QRC', teacher, lima('2026-03-02 08:45:00'));
  assert.strictEqual(late.status, 'late');
  assert.strictEqual(late.notification.status, 'simulated');
});

test('récord mensual del alumno y de la sección', () => {
  const r = reports.studentMonth(students[1].id, '2026-03');
  assert.strictEqual(r.totals.late, 1);
  assert.strictEqual(r.totals.rate, 100);
  const sec = reports.sectionMonth(r.student.section_id, '2026-03');
  assert.strictEqual(sec.students.length, 4);
  assert.deepStrictEqual(sec.dates, ['2026-03-02']);
  const csv = reports.toCsv(sec);
  assert.match(csv, /Apellidos,Nombres,02,/);
});

test('mensajes y tareas a un grupo', async () => {
  const r = await messages.create(teacher, { kind: 'task', title: 'Ejercicios', body: 'Pág. 10', due_date: '2026-03-05', target_type: 'course', target_id: course, send_whatsapp: true });
  assert.strictEqual(r.recipients, 4);
  assert.strictEqual(r.whatsapp.simulated, 4);
  const sel = await messages.create(teacher, { kind: 'comment', title: 'Felicitaciones', body: 'Buen trabajo', target_type: 'students', student_ids: [students[0].id] });
  assert.strictEqual(sel.recipients, 1);
  assert.strictEqual(messages.forStudent(students[0].id).length, 2);
  // Un docente no puede escribir a secciones donde no enseña.
  await assert.rejects(messages.create(other, { title: 'x', body: 'y', target_type: 'grade', target_id: 1 }), /Solo puede/);
  assert.ok(messages.list(admin).length >= 2);
});
