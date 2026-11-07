'use strict';
const db = require('./db');
const auth = require('./auth');
const attendance = require('./attendance');
const whatsapp = require('./whatsapp');
const { createApp } = require('./app');

db.open();

// Crea el administrador inicial si no existe ningún usuario.
const count = db.get().prepare('SELECT COUNT(*) n FROM users').get().n;
if (count === 0) {
  const email = process.env.ADMIN_EMAIL || 'admin@colegio.edu';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  db.get().prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Administrador', ?, ?, 'admin')")
    .run(email, auth.hashPassword(password));
  console.log(`Administrador inicial creado: ${email} / ${password}  (cámbielo después de ingresar)`);
}

// Revisa periódicamente las sesiones cuyo plazo venció para marcar
// ausentes y enviar las notificaciones de WhatsApp a los padres.
const intervalMs = Number(process.env.SCHEDULER_INTERVAL_SECONDS || 30) * 1000;
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const done = await attendance.processDue();
    for (const r of done) {
      console.log(`Asistencia cerrada: ${r.session.course_name} ${r.session.grade_name} "${r.session.section_name}" ${r.session.date} - ${r.notified} notificaciones`);
    }
  } catch (e) {
    console.error('Error en el programador de notificaciones:', e);
  } finally {
    running = false;
  }
}
setInterval(tick, intervalMs).unref();
tick();

const port = Number(process.env.PORT || 3000);
createApp().listen(port, () => {
  console.log(`Asistencia Escolar QR escuchando en http://localhost:${port}`);
  console.log(`Proveedor de WhatsApp: ${whatsapp.provider()}`);
});
