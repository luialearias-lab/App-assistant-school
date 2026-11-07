'use strict';
const crypto = require('node:crypto');
const db = require('./db');

const SESSION_DAYS = 7;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Código alfanumérico legible (sin caracteres ambiguos). */
function randomCode(len = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

function createSession(userId) {
  const token = randomToken();
  const expires = Date.now() + SESSION_DAYS * 864e5;
  const d = db.get();
  d.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(Date.now());
  d.prepare('INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return { token, expires };
}

function destroySession(token) {
  db.get().prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function tokenFrom(req) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return parseCookies(req.headers.cookie).sid;
}

/** Middleware: carga req.user si hay sesión válida. */
function loadUser(req, _res, next) {
  const token = tokenFrom(req);
  if (token) {
    const row = db.get().prepare(
      `SELECT u.id, u.name, u.email, u.role, u.phone FROM auth_sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`
    ).get(token, Date.now());
    if (row) {
      req.user = { ...row };
      req.authToken = token;
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}

module.exports = {
  hashPassword, verifyPassword, randomToken, randomCode,
  createSession, destroySession, loadUser, requireAuth, requireAdmin,
};
