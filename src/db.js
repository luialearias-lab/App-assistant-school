'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','teacher')),
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS grades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grade_id INTEGER NOT NULL REFERENCES grades(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tutor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (grade_id, name)
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  start_time TEXT NOT NULL DEFAULT '08:00',
  late_tolerance_min INTEGER NOT NULL DEFAULT 10,
  notify_after_min INTEGER NOT NULL DEFAULT 30,
  UNIQUE (section_id, name)
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  qr_code TEXT NOT NULL UNIQUE,
  portal_code TEXT NOT NULL UNIQUE,
  document_id TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE RESTRICT,
  guardian_name TEXT,
  guardian_phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  late_tolerance_min INTEGER NOT NULL,
  notify_after_min INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_at TEXT,
  UNIQUE (course_id, date)
);

CREATE TABLE IF NOT EXISTS attendance_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('present','late','absent','justified')),
  scanned_at TEXT,
  method TEXT NOT NULL DEFAULT 'qr',
  note TEXT,
  notified_at TEXT,
  UNIQUE (session_id, student_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('comment','task')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  due_date TEXT,
  target_type TEXT NOT NULL CHECK (target_type IN ('grade','section','course','students')),
  target_id INTEGER,
  send_whatsapp INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_recipients (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, student_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
  phone TEXT,
  body TEXT NOT NULL,
  reason TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','failed','simulated','skipped')),
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_students_section ON students(section_id);
CREATE INDEX IF NOT EXISTS idx_records_student ON attendance_records(student_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON attendance_sessions(date);
CREATE INDEX IF NOT EXISTS idx_recipients_student ON message_recipients(student_id);
`;

const DEFAULT_SETTINGS = {
  school_name: 'Mi Colegio',
  timezone: 'America/Lima',
  public_url: '',
  notify_late: '1',
  notify_absent: '1',
  template_absent:
    'Estimado(a) {apoderado}: le informamos que {alumno} ({grado} "{seccion}") NO asistió a la clase de {curso} hoy {fecha} (inicio {hora}). Si tiene una justificación, por favor comuníquese con el colegio. - {colegio}',
  template_late:
    'Estimado(a) {apoderado}: le informamos que {alumno} ({grado} "{seccion}") llegó TARDE a la clase de {curso} hoy {fecha}. Hora de registro: {hora_registro} (inicio {hora}). - {colegio}',
  template_message:
    '{colegio} - {tipo} para {alumno}: *{titulo}*\n{contenido}{entrega}',
};

let db;

function open(file) {
  const target = file || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'asistencia.db');
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

function get() {
  if (!db) open();
  return db;
}

function close() {
  if (db) db.close();
  db = undefined;
}

/** Runs fn inside a transaction. */
function tx(fn) {
  const d = get();
  d.exec('BEGIN');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function getSettings() {
  const rows = get().prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function setSetting(key, value) {
  get().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

module.exports = { open, get, close, tx, getSettings, setSetting, DEFAULT_SETTINGS };
