'use strict';
// Carga datos de demostración: grados, secciones, cursos, docentes y alumnos.
// Uso: npm run seed
const db = require('../src/db');
const auth = require('../src/auth');

db.open();
const d = db.get();

function user(name, email, password, role) {
  const u = d.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (u) return u.id;
  return Number(d.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, email, auth.hashPassword(password), role).lastInsertRowid);
}

const admin = user('Administrador', process.env.ADMIN_EMAIL || 'admin@colegio.edu', process.env.ADMIN_PASSWORD || 'admin123', 'admin');
const t1 = user('Prof. María López', 'maria@colegio.edu', 'docente123', 'teacher');
const t2 = user('Prof. Carlos Ramírez', 'carlos@colegio.edu', 'docente123', 'teacher');

const firstNames = ['Ana', 'Luis', 'Sofía', 'Mateo', 'Valentina', 'Diego', 'Camila', 'Sebastián', 'Lucía', 'Thiago', 'Isabella', 'Gabriel'];
const lastNames = ['García', 'Rodríguez', 'Pérez', 'Torres', 'Flores', 'Vargas', 'Castillo', 'Mendoza', 'Rojas', 'Silva', 'Quispe', 'Huamán'];

db.tx(() => {
  const grades = [['1ro Secundaria', 1], ['2do Secundaria', 2]];
  let n = 0;
  for (const [gname, order] of grades) {
    d.prepare('INSERT OR IGNORE INTO grades (name, sort_order) VALUES (?, ?)').run(gname, order);
    const gid = d.prepare('SELECT id FROM grades WHERE name = ?').get(gname).id;
    for (const sname of ['A', 'B']) {
      d.prepare('INSERT OR IGNORE INTO sections (grade_id, name, tutor_id) VALUES (?, ?, ?)').run(gid, sname, sname === 'A' ? t1 : t2);
      const sid = d.prepare('SELECT id FROM sections WHERE grade_id = ? AND name = ?').get(gid, sname).id;
      const courses = [['Matemática', t1, '08:00'], ['Comunicación', t2, '10:00'], ['Ciencia y Tecnología', t1, '11:30']];
      for (const [cname, teacher, start] of courses) {
        d.prepare('INSERT OR IGNORE INTO courses (section_id, name, teacher_id, start_time, late_tolerance_min, notify_after_min) VALUES (?, ?, ?, ?, 10, 30)')
          .run(sid, cname, teacher, start);
      }
      const existing = d.prepare('SELECT COUNT(*) n FROM students WHERE section_id = ?').get(sid).n;
      if (existing) continue;
      for (let i = 0; i < 8; i++) {
        const fn = firstNames[(n + i) % firstNames.length];
        const ln = `${lastNames[(n + i * 3) % lastNames.length]} ${lastNames[(n + i * 5 + 1) % lastNames.length]}`;
        d.prepare(
          `INSERT INTO students (first_name, last_name, document_id, section_id, guardian_name, guardian_phone, qr_code, portal_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(fn, ln, String(70000000 + n * 10 + i), sid, `Sr(a). ${ln.split(' ')[0]}`, `9${String(10000000 + n * 10 + i).padStart(8, '0')}`, auth.randomCode(12), auth.randomCode(10));
      }
      n += 8;
    }
  }
});

console.log('Datos de demostración cargados.');
console.log('  Admin:   ', process.env.ADMIN_EMAIL || 'admin@colegio.edu', '/', process.env.ADMIN_PASSWORD || 'admin123');
console.log('  Docentes: maria@colegio.edu / docente123, carlos@colegio.edu / docente123');
void admin;
db.close();
