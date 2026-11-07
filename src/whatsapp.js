'use strict';
// Envío de mensajes de WhatsApp. Proveedores soportados:
//   - "meta":     WhatsApp Business Cloud API (graph.facebook.com)
//   - "twilio":   Twilio WhatsApp API
//   - "simulado": no envía nada, solo registra el mensaje (por defecto)
const db = require('./db');
const { localNow } = require('./time');

function provider() {
  return (process.env.WHATSAPP_PROVIDER || 'simulado').toLowerCase();
}

/** Normaliza un teléfono a formato E.164 sin '+', usando el código de país por defecto. */
function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/[^\d+]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) return p.slice(1);
  if (p.startsWith('00')) return p.slice(2);
  const cc = (process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '51').replace(/\D/g, '');
  if (cc && !p.startsWith(cc)) p = cc + p.replace(/^0+/, '');
  return p;
}

async function sendViaMeta(to, body) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error('Faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID');
  const version = process.env.WHATSAPP_API_VERSION || 'v21.0';
  const template = process.env.WHATSAPP_TEMPLATE_NAME;
  // Fuera de la ventana de 24 h, Meta exige plantillas aprobadas. Si se configura
  // WHATSAPP_TEMPLATE_NAME se envía la plantilla con el texto como único parámetro.
  const payload = template
    ? {
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
          name: template,
          language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'es' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: body.slice(0, 1000) }] }],
        },
      }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body } };
  const res = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Meta API ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function sendViaTwilio(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM; // ej: +14155238886
  if (!sid || !tok || !from) throw new Error('Faltan TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN o TWILIO_WHATSAPP_FROM');
  const form = new URLSearchParams({
    From: `whatsapp:${from.startsWith('+') ? from : '+' + from}`,
    To: `whatsapp:+${to}`,
    Body: body,
  });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/**
 * Envía un WhatsApp y lo registra en la tabla de notificaciones.
 * Nunca lanza excepción: devuelve el estado final.
 */
async function send({ studentId, phone, body, reason }) {
  const prov = provider();
  const to = normalizePhone(phone);
  let status = 'sent';
  let error = null;
  if (!to) {
    status = 'skipped';
    error = 'El alumno no tiene teléfono de apoderado registrado';
  } else {
    try {
      if (prov === 'meta') await sendViaMeta(to, body);
      else if (prov === 'twilio') await sendViaTwilio(to, body);
      else status = 'simulated';
    } catch (e) {
      status = 'failed';
      error = e.message;
    }
  }
  const { timezone } = db.getSettings();
  db.get().prepare(
    `INSERT INTO notifications (student_id, phone, body, reason, provider, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(studentId ?? null, to, body, reason, prov, status, error, localNow(timezone).stamp);
  if (status === 'simulated') console.log(`[WhatsApp simulado] -> ${to}: ${body.replace(/\n/g, ' ')}`);
  if (status === 'failed') console.error(`[WhatsApp] error enviando a ${to}: ${error}`);
  return { status, error };
}

/** Reemplaza {variables} en una plantilla. */
function render(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m));
}

module.exports = { send, render, normalizePhone, provider };
