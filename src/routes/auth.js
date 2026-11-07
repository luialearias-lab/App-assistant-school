'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

// Limitador simple de intentos de inicio de sesión por IP.
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  attempts.set(ip, a);
  return a.length >= 10;
}

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Demasiados intentos. Intente en unos minutos.' });
  const user = db.get().prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
  if (!user || !auth.verifyPassword(password || '', user.password_hash)) {
    attempts.get(req.ip).push(Date.now());
    return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
  }
  const { token, expires } = auth.createSession(user.id);
  res.cookie('sid', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    expires: new Date(expires),
  });
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

router.post('/logout', (req, res) => {
  if (req.authToken) auth.destroySession(req.authToken);
  res.clearCookie('sid');
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });
  const s = db.getSettings();
  res.json({ user: req.user, school_name: s.school_name, timezone: s.timezone });
});

router.post('/password', auth.requireAuth, (req, res) => {
  const { current, password } = req.body || {};
  const u = db.get().prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!auth.verifyPassword(current || '', u.password_hash)) return res.status(400).json({ error: 'Contraseña actual incorrecta' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
  db.get().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), u.id);
  res.json({ ok: true });
});

module.exports = router;
