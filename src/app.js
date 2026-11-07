'use strict';
const path = require('node:path');
const express = require('express');
const auth = require('./auth');
const { reportsRouter, messagesRouter, portalRouter } = require('./routes/misc');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.use(auth.loadUser);

  // Protección CSRF básica: las peticiones que modifican datos deben venir del mismo origen.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin && new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Origen no permitido' });
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/attendance', require('./routes/attendance'));
  app.use('/api/reports', reportsRouter);
  app.use('/api/messages', messagesRouter);
  app.use('/api/portal', portalRouter);
  app.use('/api', require('./routes/admin'));

  app.get('/vendor/html5-qrcode.min.js', (_req, res) => {
    res.sendFile(require.resolve('html5-qrcode/html5-qrcode.min.js'));
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Error interno del servidor' : err.message });
  });
  return app;
}

module.exports = { createApp };
