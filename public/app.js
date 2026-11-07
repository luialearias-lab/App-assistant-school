'use strict';
/* Aplicación web de asistencia escolar (SPA sin dependencias). */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = { present: 'Presente', late: 'Tarde', absent: 'Falta', justified: 'Justificada', pending: 'Pendiente' };
const SHORT = { present: 'P', late: 'T', absent: 'F', justified: 'J' };
const NOTIF = { sent: 'Enviado', simulated: 'Simulado', failed: 'Error', skipped: 'Sin teléfono' };
const fmtDate = (d) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');
const badge = (st) => `<span class="badge st-${st || 'pending'}">${STATUS[st || 'pending']}</span>`;

const state = { user: null, timezone: 'America/Lima', scanner: null, timers: [] };

// ---------- Utilidades ----------
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    showLogin();
    throw new Error('Sesión expirada');
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `Error ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function openModal(title, html, onMount) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').classList.remove('hidden');
  if (onMount) onMount($('#modal-body'));
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modal-body').innerHTML = '';
}
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal();
});

function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else o[el.name] = el.value;
  }
  return o;
}

/** Asocia el submit de un formulario con una acción asíncrona y muestra errores. */
function onSubmit(form, fn) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    if (btn) btn.disabled = true;
    try {
      await fn(formData(form), form);
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

const options = (list, value, label, sel, empty) =>
  (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '') +
  list.map((x) => `<option value="${x[value]}" ${String(x[value]) === String(sel ?? '') ? 'selected' : ''}>${esc(label(x))}</option>`).join('');

const sectionLabel = (s) => `${s.grade_name} "${s.name}"`;
const isAdmin = () => state.user && state.user.role === 'admin';
const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: state.timezone, year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: state.timezone }).format(new Date());

function query() {
  const i = location.hash.indexOf('?');
  return new URLSearchParams(i >= 0 ? location.hash.slice(i + 1) : '');
}

// ---------- Sesión ----------
function showLogin() {
  stopScanner();
  $('#shell').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

onSubmit($('#login-form'), async (data) => {
  $('#login-error').textContent = '';
  try {
    await api('/auth/login', { method: 'POST', body: data });
    await boot();
  } catch (e) {
    $('#login-error').textContent = e.message;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  showLogin();
});
$('#menu-btn').addEventListener('click', () => $('#nav').classList.toggle('open'));
$('#nav').addEventListener('click', (e) => { if (e.target.closest('a')) $('#nav').classList.remove('open'); });

async function boot() {
  try {
    const me = await api('/auth/me');
    state.user = me.user;
    state.timezone = me.timezone;
    $('#school-name').textContent = me.school_name;
    document.title = `Asistencia - ${me.school_name}`;
    $('#user-name').textContent = `${me.user.name} (${me.user.role === 'admin' ? 'Administrador' : 'Docente'})`;
    $$('.admin-only').forEach((el) => el.classList.toggle('hidden', me.user.role !== 'admin'));
    $('#login').classList.add('hidden');
    $('#shell').classList.remove('hidden');
    route();
  } catch {
    showLogin();
  }
}

// ---------- Enrutador ----------
const routes = {
  '': viewDashboard,
  asistencia: viewAttendance,
  record: viewRecord,
  alumno: viewStudentRecord,
  mensajes: viewMessages,
  alumnos: viewStudents,
  notificaciones: viewNotifications,
  estructura: viewStructure,
  usuarios: viewUsers,
  config: viewConfig,
  cuenta: viewAccount,
};

async function route() {
  if (!state.user) return;
  stopScanner();
  state.timers.forEach(clearInterval);
  state.timers = [];
  const path = location.hash.replace(/^#\/?/, '').split('?')[0];
  const [name, ...params] = path.split('/');
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === (name === 'alumno' ? 'record' : name)));
  const view = $('#view');
  view.innerHTML = '<p class="muted">Cargando…</p>';
  try {
    await (routes[name] || viewDashboard)(view, ...params);
  } catch (e) {
    view.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p></div>`;
  }
}
window.addEventListener('hashchange', route);

// ---------- Panel del día ----------
async function viewDashboard(view) {
  const data = await api('/attendance/today');
  const courses = data.courses;
  view.innerHTML = `
    <div class="page-head"><h1>Panel del día</h1><span class="muted">${fmtDate(data.date)}</span></div>
    ${courses.length ? '' : `<div class="card empty">No tiene cursos asignados. ${isAdmin() ? 'Créelos en <a href="#/estructura">Grados, secciones y cursos</a>.' : 'Pida al administrador que le asigne cursos.'}</div>`}
    <div class="grid">
      ${courses.map((c) => {
        const pending = c.total - c.present - c.late - c.absent - c.justified;
        return `<div class="card course-card">
          <h3>${esc(c.course_name)}</h3>
          <div class="muted small">${esc(c.grade_name)} "${esc(c.section_name)}" · ${esc(c.start_time)} · ${esc(c.teacher_name || 'Sin docente')}</div>
          <div class="stats">
            <div class="stat st-present"><b>${c.present}</b><span>Presentes</span></div>
            <div class="stat st-late"><b>${c.late}</b><span>Tarde</span></div>
            <div class="stat st-absent"><b>${c.absent}</b><span>Faltas</span></div>
            <div class="stat st-pending"><b>${c.session_id ? pending : c.total}</b><span>Pendientes</span></div>
          </div>
          <div class="row">
            <span class="auto">${c.session_id ? (c.session_status === 'open' ? '<span class="badge st-present">Abierta</span>' : '<span class="badge st-pending">Cerrada</span>') : '<span class="badge st-pending">Sin iniciar</span>'}</span>
            <a class="btn primary auto" href="#/asistencia/${c.course_id}">📷 ${c.session_id ? 'Ver asistencia' : 'Tomar asistencia'}</a>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

// ---------- Tomar asistencia ----------
async function viewAttendance(view, courseId) {
  if (!courseId) {
    const courses = await api('/courses' + (isAdmin() ? '' : '?mine=1'));
    view.innerHTML = `
      <div class="page-head"><h1>Tomar asistencia</h1></div>
      <div class="card"><form id="pick" class="row">
        <label>Curso<select name="course" required>${options(courses, 'id', (c) => `${c.name} — ${c.grade_name} "${c.section_name}" (${c.start_time})`, null, 'Seleccione…')}</select></label>
        <label class="auto">Fecha<input type="date" name="date" value="${today()}"></label>
        <button class="btn primary auto" type="submit">Abrir lista</button>
      </form></div>`;
    onSubmit($('#pick'), (d) => { location.hash = `#/asistencia/${d.course}?fecha=${d.date}`; });
    return;
  }
  const date = query().get('fecha') || undefined;
  let data = await api('/attendance/sessions', { method: 'POST', body: { course_id: Number(courseId), date } });
  const sid = data.session.id;

  view.innerHTML = `
    <div class="page-head">
      <h1>${esc(data.session.course_name)} · ${esc(data.session.grade_name)} "${esc(data.session.section_name)}"</h1>
      <a class="btn auto" href="#/asistencia">Cambiar curso</a>
    </div>
    <p class="muted" id="session-info"></p>
    <div class="scan-layout">
      <div class="card stack">
        <div id="reader"></div>
        <div class="row">
          <button class="btn primary" id="cam-btn">📷 Iniciar cámara</button>
          <select id="cam-select" class="hidden"></select>
        </div>
        <form id="manual" class="row">
          <label>Código QR (lector USB o manual)<input name="code" id="code-input" autocomplete="off" placeholder="ASIS:XXXXXXXXXXXX"></label>
          <button class="btn auto" type="submit">Registrar</button>
        </form>
        <div id="flash"></div>
      </div>
      <div class="card">
        <div class="stats" id="counts"></div>
        <div class="row" style="margin:.75rem 0">
          <span class="spacer"></span>
          <button class="btn auto" id="reopen-btn">↺ Reabrir</button>
          <button class="btn primary auto" id="close-btn">✔ Cerrar y notificar a padres</button>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Alumno</th><th>Estado</th><th>Hora</th><th>Cambiar</th></tr></thead>
          <tbody id="roster"></tbody>
        </table></div>
      </div>
    </div>`;

  function render(d) {
    data = d;
    const s = d.session;
    $('#session-info').innerHTML = `Fecha ${fmtDate(s.date)} · Inicio ${esc(s.start_time)} · Tolerancia ${s.late_tolerance_min} min ·
      ${s.status === 'open' ? `Se notificará a los padres de ausentes y tardanzas automáticamente a las <b>${esc(s.deadline.slice(11, 16))}</b>` : `<b>Lista cerrada</b> ${s.closed_at ? 'el ' + esc(s.closed_at.slice(11, 16)) : ''}. Los alumnos que lleguen ahora se registran como tarde y se avisa al instante.`}`;
    const c = d.counts;
    $('#counts').innerHTML = ['present', 'late', 'absent', 'justified', 'pending']
      .map((k) => `<div class="stat st-${k}"><b>${c[k]}</b><span>${STATUS[k]}</span></div>`).join('');
    $('#close-btn').classList.toggle('hidden', s.status !== 'open');
    $('#reopen-btn').classList.toggle('hidden', s.status === 'open');
    $('#roster').innerHTML = d.students.map((st) => `
      <tr>
        <td><a href="#/alumno/${st.id}">${esc(st.last_name)}, ${esc(st.first_name)}</a>${st.note ? `<div class="muted small">${esc(st.note)}</div>` : ''}</td>
        <td>${badge(st.status)}${st.notified_at && ['absent', 'late'].includes(st.status) ? ' <span title="Padres notificados">💬</span>' : ''}</td>
        <td class="small">${st.scanned_at ? esc(st.scanned_at.slice(11, 16)) : '—'}</td>
        <td><div class="status-btns">${['present', 'late', 'absent', 'justified'].map((k) =>
          `<button data-st="${k}" data-id="${st.id}" class="${k} ${st.status === k ? 'on' : ''}" title="${STATUS[k]}">${SHORT[k]}</button>`).join('')}</div></td>
      </tr>`).join('') || '<tr><td colspan="4" class="empty">No hay alumnos en esta sección</td></tr>';
  }
  render(data);

  $('#roster').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-st]');
    if (!b) return;
    let note;
    if (b.dataset.st === 'justified') {
      note = prompt('Motivo de la justificación (opcional):') ?? undefined;
    }
    try {
      render(await api(`/attendance/sessions/${sid}/students/${b.dataset.id}`, { method: 'PUT', body: { status: b.dataset.st, note } }));
    } catch (err) { toast(err.message, true); }
  });

  $('#close-btn').addEventListener('click', async () => {
    if (!confirm('Se marcará FALTA a los alumnos pendientes y se enviará WhatsApp a los padres de ausentes y tardanzas. ¿Continuar?')) return;
    try {
      const r = await api(`/attendance/sessions/${sid}/close`, { method: 'POST' });
      render(r);
      toast(`Lista cerrada. ${r.notified} notificaciones enviadas.`);
    } catch (err) { toast(err.message, true); }
  });
  $('#reopen-btn').addEventListener('click', async () => {
    try { render(await api(`/attendance/sessions/${sid}/reopen`, { method: 'POST' })); } catch (err) { toast(err.message, true); }
  });

  const flash = (msg, cls) => {
    $('#flash').innerHTML = `<div class="scan-flash ${cls}">${esc(msg)}</div>`;
  };
  let last = { code: '', at: 0 };
  async function register(code) {
    code = code.trim();
    if (!code) return;
    if (code === last.code && Date.now() - last.at < 4000) return; // evita lecturas repetidas
    last = { code, at: Date.now() };
    try {
      const r = await api(`/attendance/sessions/${sid}/scan`, { method: 'POST', body: { code } });
      if (r.result === 'duplicate') {
        flash(`${r.student.name}: ya registrado (${STATUS[r.status]})`, 'st-pending');
        beep(440);
      } else {
        flash(`${r.student.name}: ${STATUS[r.status]} ${r.scanned_at.slice(11, 16)}`, `st-${r.status}`);
        beep(r.status === 'present' ? 880 : 620);
      }
      render(await api(`/attendance/sessions/${sid}`));
    } catch (err) {
      flash(err.message, 'st-absent');
      beep(200);
    }
  }

  onSubmit($('#manual'), async (d, form) => {
    await register(d.code);
    form.reset();
    $('#code-input').focus();
  });

  $('#cam-btn').addEventListener('click', async () => {
    if (state.scanner) { stopScanner(); $('#cam-btn').textContent = '📷 Iniciar cámara'; return; }
    await startScanner(register, $('#cam-select').value || undefined);
  });
  $('#cam-select').addEventListener('change', async () => {
    stopScanner();
    await startScanner(register, $('#cam-select').value);
  });

  state.timers.push(setInterval(async () => {
    try { render(await api(`/attendance/sessions/${sid}`)); } catch { /* ignorar */ }
  }, 15000));
}

async function startScanner(onCode, cameraId) {
  if (!window.Html5Qrcode) return toast('No se pudo cargar el lector QR', true);
  if (!window.isSecureContext) return toast('La cámara requiere HTTPS (o localhost). Use el campo de código manual o configure HTTPS.', true);
  try {
    const cams = await Html5Qrcode.getCameras();
    const sel = $('#cam-select');
    if (cams.length > 1 && sel.options.length === 0) {
      sel.innerHTML = cams.map((c) => `<option value="${esc(c.id)}">${esc(c.label || 'Cámara')}</option>`).join('');
      sel.classList.remove('hidden');
    }
    const scanner = new Html5Qrcode('reader');
    await scanner.start(cameraId || { facingMode: 'environment' }, { fps: 10, qrbox: { width: 240, height: 240 } }, (text) => onCode(text), () => {});
    state.scanner = scanner;
    $('#cam-btn').textContent = '⏹ Detener cámara';
  } catch (e) {
    toast('No se pudo iniciar la cámara: ' + (e.message || e), true);
  }
}

function stopScanner() {
  const s = state.scanner;
  state.scanner = null;
  if (s) s.stop().then(() => s.clear()).catch(() => {});
}

let audioCtx;
function beep(freq) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    g.gain.value = 0.08;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.15);
    if (navigator.vibrate) navigator.vibrate(80);
  } catch { /* sin audio */ }
}

// ---------- Récord mensual ----------
async function viewRecord(view) {
  const q = query();
  const sections = await api('/sections');
  const mySections = isAdmin() ? sections : await filterMySections(sections);
  const sectionId = q.get('seccion') || (mySections[0] && mySections[0].id) || '';
  const month = q.get('mes') || thisMonth();
  const courses = sectionId ? await api(`/courses?section_id=${sectionId}`) : [];
  const courseId = q.get('curso') || '';
  view.innerHTML = `
    <div class="page-head"><h1>Récord mensual</h1></div>
    <div class="card"><form id="f" class="row">
      <label>Grado y sección<select name="seccion">${options(mySections, 'id', sectionLabel, sectionId, mySections.length ? undefined : 'Sin secciones')}</select></label>
      <label>Curso<select name="curso">${options(courses, 'id', (c) => c.name, courseId, 'Todos los cursos')}</select></label>
      <label class="auto">Mes<input type="month" name="mes" value="${month}"></label>
      <button class="btn primary auto" type="submit">Ver</button>
    </form></div>
    <div id="out" style="margin-top:1rem"></div>`;
  $('#f [name=seccion]').addEventListener('change', (e) => { location.hash = `#/record?seccion=${e.target.value}&mes=${$('#f [name=mes]').value}`; });
  onSubmit($('#f'), (d) => { location.hash = `#/record?seccion=${d.seccion}&curso=${d.curso}&mes=${d.mes}`; });
  if (!sectionId) return;
  const r = await api(`/reports/section/${sectionId}?month=${month}${courseId ? '&course_id=' + courseId : ''}`);
  const csvUrl = `/api/reports/section/${sectionId}?month=${month}&format=csv${courseId ? '&course_id=' + courseId : ''}`;
  $('#out').innerHTML = `
    <div class="page-head no-print"><h2 style="flex:1;margin:0">${esc(r.section.grade_name)} "${esc(r.section.name)}" — ${esc(month)}</h2>
      <a class="btn auto" href="${csvUrl}">⬇ Exportar Excel (CSV)</a>
      <button class="btn auto" onclick="window.print()">🖨 Imprimir</button></div>
    <p class="muted small">P = Presente · T = Tarde · F = Falta · J = Justificada. Haga clic en un alumno para ver su récord detallado.</p>
    <div class="table-wrap"><table class="matrix">
      <thead><tr><th>Alumno</th>${r.dates.map((d) => `<th title="${fmtDate(d)}">${d.slice(8)}</th>`).join('')}
        <th>P</th><th>T</th><th>F</th><th>J</th><th>%</th></tr></thead>
      <tbody>${r.students.map((s) => `<tr>
        <td><a href="#/alumno/${s.id}?mes=${month}">${esc(s.last_name)}, ${esc(s.first_name)}</a></td>
        ${r.dates.map((d) => s.days[d] ? `<td><span class="dot st-${s.days[d]}">${SHORT[s.days[d]]}</span></td>` : '<td></td>').join('')}
        <td>${s.present}</td><td>${s.late}</td><td>${s.absent}</td><td>${s.justified}</td>
        <td><b>${s.rate ?? '—'}${s.rate !== null ? '%' : ''}</b></td></tr>`).join('') || '<tr><td class="empty">Sin alumnos</td></tr>'}
      </tbody></table></div>`;
}

async function filterMySections(sections) {
  const mine = await api('/courses?mine=1');
  const ids = new Set(mine.map((c) => c.section_id));
  return sections.filter((s) => ids.has(s.id) || s.tutor_id === state.user.id);
}

async function viewStudentRecord(view, id) {
  const month = query().get('mes') || thisMonth();
  const r = await api(`/reports/student/${id}?month=${month}`);
  view.innerHTML = `
    <div class="page-head">
      <h1>${esc(r.student.last_name)}, ${esc(r.student.first_name)}</h1>
      <form id="m" class="auto row"><input type="month" name="mes" value="${month}" class="auto"></form>
      <button class="btn auto no-print" onclick="window.print()">🖨 Imprimir</button>
    </div>
    ${studentRecordHtml(r)}`;
  $('#m [name=mes]').addEventListener('change', (e) => { location.hash = `#/alumno/${id}?mes=${e.target.value}`; });
}

function studentRecordHtml(r) {
  const t = r.totals;
  const courses = Object.entries(r.by_course);
  return `
    <p class="muted">${esc(r.student.grade_name)} "${esc(r.student.section_name)}"${r.student.document_id ? ' · Doc. ' + esc(r.student.document_id) : ''}${r.student.guardian_name ? ' · Apoderado: ' + esc(r.student.guardian_name) : ''}</p>
    <div class="card stack">
      <div class="stats">
        <div class="stat st-present"><b>${t.present}</b><span>Presente</span></div>
        <div class="stat st-late"><b>${t.late}</b><span>Tarde</span></div>
        <div class="stat st-absent"><b>${t.absent}</b><span>Faltas</span></div>
        <div class="stat st-justified"><b>${t.justified}</b><span>Justificadas</span></div>
        <div class="stat st-pending"><b>${t.rate ?? '—'}${t.rate !== null ? '%' : ''}</b><span>Asistencia</span></div>
      </div>
      ${calendarHtml(r.month, r.by_day)}
    </div>
    ${courses.length ? `<h3 style="margin-top:1.25rem">Por curso</h3>
    <div class="table-wrap"><table><thead><tr><th>Curso</th><th class="num">P</th><th class="num">T</th><th class="num">F</th><th class="num">J</th><th class="num">%</th></tr></thead>
    <tbody>${courses.map(([n, c]) => `<tr><td>${esc(n)}</td><td class="num">${c.present}</td><td class="num">${c.late}</td><td class="num">${c.absent}</td><td class="num">${c.justified}</td><td class="num"><b>${c.rate}%</b></td></tr>`).join('')}</tbody></table></div>` : ''}
    <h3 style="margin-top:1.25rem">Detalle</h3>
    <div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Curso</th><th>Estado</th><th>Hora registro</th><th>Nota</th></tr></thead>
    <tbody>${r.records.map((x) => `<tr><td>${fmtDate(x.date)}</td><td>${esc(x.course_name)}</td><td>${badge(x.status)}</td><td>${x.scanned_at ? esc(x.scanned_at.slice(11, 16)) : '—'}</td><td class="small">${esc(x.note || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Sin registros este mes</td></tr>'}</tbody></table></div>`;
}

function calendarHtml(month, byDay) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const order = { absent: 3, late: 2, justified: 1, present: 0 };
  let cells = '';
  for (let i = 0; i < (first + 6) % 7; i++) cells += '<td></td>';
  for (let d = 1; d <= days; d++) {
    const key = `${month}-${String(d).padStart(2, '0')}`;
    const sts = byDay[key];
    const worst = sts ? sts.reduce((a, b) => (order[b] > order[a] ? b : a)) : null;
    cells += `<td><span class="dot ${worst ? 'st-' + worst : ''}" title="${sts ? sts.map((s) => STATUS[s]).join(', ') : ''}">${d}</span></td>`;
    if ((first + 6 + d) % 7 === 0) cells += '</tr><tr>';
  }
  return `<div class="table-wrap"><table class="matrix"><thead><tr>${['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'].map((d) => `<th class="num">${d}</th>`).join('')}</tr></thead><tbody><tr>${cells}</tr></tbody></table></div>`;
}

// ---------- Mensajes y tareas ----------
async function viewMessages(view) {
  const [grades, sections, courses, list] = await Promise.all([
    api('/grades'), api('/sections'), api('/courses' + (isAdmin() ? '' : '?mine=1')), api('/messages'),
  ]);
  const mySections = isAdmin() ? sections : sections.filter((s) => courses.some((c) => c.section_id === s.id));
  const myGrades = isAdmin() ? grades : grades.filter((g) => mySections.some((s) => s.grade_id === g.id));
  view.innerHTML = `
    <div class="page-head"><h1>Tareas y comentarios</h1></div>
    <div class="card"><form id="f" class="stack">
      <div class="row">
        <label class="auto">Tipo<select name="kind"><option value="task">📝 Tarea</option><option value="comment">💬 Comentario</option></select></label>
        <label>Enviar a<select name="target_type">
          <option value="course">Un curso</option><option value="section">Una sección completa</option>
          <option value="grade">Un grado completo</option><option value="students">Alumnos seleccionados</option></select></label>
        <label id="target-wrap">Destino<select name="target_id" id="target"></select></label>
      </div>
      <div id="pick-wrap" class="hidden">
        <label>Sección<select id="pick-section">${options(mySections, 'id', sectionLabel, null, 'Seleccione…')}</select></label>
        <div id="pick" class="pick-list"></div>
      </div>
      <label>Título<input name="title" required maxlength="150"></label>
      <label>Contenido<textarea name="body" required maxlength="4000"></textarea></label>
      <div class="row">
        <label class="auto" id="due-wrap">Fecha de entrega<input type="date" name="due_date"></label>
        <label class="check auto"><input type="checkbox" name="send_whatsapp" checked> Enviar también por WhatsApp a los padres</label>
        <span class="spacer"></span>
        <button class="btn primary auto" type="submit">Enviar</button>
      </div>
    </form></div>
    <h2 style="margin-top:1.5rem">Enviados</h2>
    <div class="stack" id="list"></div>`;

  const f = $('#f');
  function fillTarget() {
    const t = f.target_type.value;
    $('#pick-wrap').classList.toggle('hidden', t !== 'students');
    $('#target-wrap').classList.toggle('hidden', t === 'students');
    const sel = $('#target');
    if (t === 'course') sel.innerHTML = options(courses, 'id', (c) => `${c.name} — ${c.grade_name} "${c.section_name}"`);
    if (t === 'section') sel.innerHTML = options(mySections, 'id', sectionLabel);
    if (t === 'grade') sel.innerHTML = options(myGrades, 'id', (g) => g.name);
  }
  f.target_type.addEventListener('change', fillTarget);
  f.kind.addEventListener('change', () => $('#due-wrap').classList.toggle('hidden', f.kind.value !== 'task'));
  $('#pick-section').addEventListener('change', async (e) => {
    const st = e.target.value ? await api(`/students?section_id=${e.target.value}`) : [];
    $('#pick').innerHTML = st.map((s) => `<label class="check"><input type="checkbox" value="${s.id}"> ${esc(s.last_name)}, ${esc(s.first_name)}</label>`).join('') || '<span class="muted">Sin alumnos</span>';
  });
  fillTarget();

  onSubmit(f, async (d) => {
    const body = { ...d };
    if (d.kind !== 'task') delete body.due_date;
    if (d.target_type === 'students') body.student_ids = $$('#pick input:checked').map((i) => Number(i.value));
    const r = await api('/messages', { method: 'POST', body });
    let msg = `Enviado a ${r.recipients} alumno(s).`;
    if (r.whatsapp) msg += ` WhatsApp: ${r.whatsapp.sent + r.whatsapp.simulated} ok, ${r.whatsapp.failed} error, ${r.whatsapp.skipped} sin teléfono.`;
    toast(msg);
    route();
  });

  $('#list').innerHTML = list.map((m) => `
    <div class="card msg ${m.kind}">
      <div class="row"><div><b>${m.kind === 'task' ? '📝 Tarea' : '💬 Comentario'}: ${esc(m.title)}</b>
        <div class="muted small">${esc(m.target_label || '')} · ${m.recipients} alumno(s) · ${esc(m.author_name || '')} · ${esc(m.created_at.slice(0, 16))}${m.send_whatsapp ? ' · WhatsApp' : ''}</div></div>
        <button class="btn small danger auto" data-del="${m.id}">Eliminar</button></div>
      <p>${esc(m.body)}</p>
      ${m.due_date ? `<div class="small"><b>Entrega:</b> ${fmtDate(m.due_date)}</div>` : ''}
    </div>`).join('') || '<div class="card empty">Aún no ha enviado mensajes</div>';
  $('#list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b || !confirm('¿Eliminar este mensaje? Dejará de verse en el portal de los alumnos.')) return;
    try { await api(`/messages/${b.dataset.del}`, { method: 'DELETE' }); route(); } catch (err) { toast(err.message, true); }
  });
}

// ---------- Alumnos ----------
async function viewStudents(view) {
  const q = query();
  const [grades, sections] = await Promise.all([api('/grades'), api('/sections')]);
  const gradeId = q.get('grado') || '';
  const sectionId = q.get('seccion') || '';
  const search = q.get('q') || '';
  const params = new URLSearchParams();
  if (gradeId) params.set('grade_id', gradeId);
  if (sectionId) params.set('section_id', sectionId);
  if (search) params.set('q', search);
  const students = await api('/students?' + params);
  const secs = gradeId ? sections.filter((s) => String(s.grade_id) === gradeId) : sections;
  view.innerHTML = `
    <div class="page-head"><h1>Alumnos</h1>
      ${isAdmin() ? `<button class="btn auto" id="import-btn">⬆ Importar lista</button>
      <button class="btn auto" id="cards-btn">🪪 Imprimir carnés QR</button>
      <button class="btn primary auto" id="new-btn">+ Nuevo alumno</button>` : ''}</div>
    <div class="card"><form id="f" class="row">
      <label>Grado<select name="grado">${options(grades, 'id', (g) => g.name, gradeId, 'Todos')}</select></label>
      <label>Sección<select name="seccion">${options(secs, 'id', sectionLabel, sectionId, 'Todas')}</select></label>
      <label>Buscar<input name="q" value="${esc(search)}" placeholder="Nombre o documento"></label>
      <button class="btn auto" type="submit">Filtrar</button>
    </form></div>
    <p class="muted small">${students.length} alumno(s)</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Alumno</th><th>Grado / Sección</th><th>Documento</th><th>Apoderado</th><th>WhatsApp</th><th></th></tr></thead>
      <tbody>${students.map((s) => `<tr>
        <td><a href="#/alumno/${s.id}">${esc(s.last_name)}, ${esc(s.first_name)}</a></td>
        <td>${esc(s.grade_name)} "${esc(s.section_name)}"</td>
        <td>${esc(s.document_id || '')}</td>
        <td>${esc(s.guardian_name || '')}</td>
        <td>${esc(s.guardian_phone || '')}</td>
        <td>${isAdmin() ? `<button class="btn small" data-qr="${s.id}">QR</button> <button class="btn small" data-edit="${s.id}">Editar</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">No hay alumnos</td></tr>'}</tbody>
    </table></div>`;

  $('#f [name=grado]').addEventListener('change', (e) => { location.hash = `#/alumnos?grado=${e.target.value}`; });
  onSubmit($('#f'), (d) => { location.hash = `#/alumnos?grado=${d.grado}&seccion=${d.seccion}&q=${encodeURIComponent(d.q)}`; });
  if (!isAdmin()) return;

  const byId = new Map(students.map((s) => [String(s.id), s]));
  $('#new-btn').addEventListener('click', () => studentForm(sections, { section_id: sectionId }));
  $('#cards-btn').addEventListener('click', () => {
    if (!sectionId) return toast('Seleccione primero una sección', true);
    window.open(`/cards.html?section_id=${sectionId}`, '_blank');
  });
  $('#import-btn').addEventListener('click', () => importForm(sections, sectionId));
  view.querySelector('tbody').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) studentForm(sections, byId.get(ed.dataset.edit));
    const qr = e.target.closest('[data-qr]');
    if (qr) showQr(byId.get(qr.dataset.qr));
  });
}

function studentForm(sections, s = {}) {
  openModal(s.id ? 'Editar alumno' : 'Nuevo alumno', `
    <form id="sf">
      <div class="row"><label>Nombres<input name="first_name" required value="${esc(s.first_name || '')}"></label>
      <label>Apellidos<input name="last_name" required value="${esc(s.last_name || '')}"></label></div>
      <div class="row"><label>Documento (DNI)<input name="document_id" value="${esc(s.document_id || '')}"></label>
      <label>Grado y sección<select name="section_id" required>${options(sections, 'id', sectionLabel, s.section_id, 'Seleccione…')}</select></label></div>
      <label>Nombre del padre/madre/apoderado<input name="guardian_name" value="${esc(s.guardian_name || '')}"></label>
      <label>WhatsApp del apoderado (con código de país, ej. +51987654321)<input name="guardian_phone" type="tel" value="${esc(s.guardian_phone || '')}"></label>
      <div class="row">${s.id ? '<button type="button" class="btn danger auto" id="del">Dar de baja</button>' : ''}<span class="spacer"></span>
      <button class="btn primary auto" type="submit">Guardar</button></div>
    </form>`, (root) => {
    onSubmit($('#sf', root), async (d) => {
      await api(s.id ? `/students/${s.id}` : '/students', { method: s.id ? 'PUT' : 'POST', body: d });
      closeModal();
      toast('Alumno guardado');
      route();
    });
    const del = $('#del', root);
    if (del) del.addEventListener('click', async () => {
      if (!confirm('¿Dar de baja al alumno? Su historial se conserva.')) return;
      await api(`/students/${s.id}`, { method: 'DELETE' });
      closeModal();
      route();
    });
  });
}

async function showQr(s) {
  const data = await api(`/qr-cards?section_id=${s.section_id}&ids=${s.id}`);
  const c = data.cards[0];
  openModal(`${s.last_name}, ${s.first_name}`, `
    <div class="center"><img src="${c.qr}" alt="QR" style="width:240px;max-width:100%"></div>
    <label>Enlace del portal para padres/alumno<input readonly value="${esc(c.portal_url)}" onclick="this.select()"></label>
    <div class="row"><button class="btn auto" id="copy">Copiar enlace</button>
    <a class="btn auto" href="/cards.html?section_id=${s.section_id}&ids=${s.id}" target="_blank">Imprimir carné</a>
    <span class="spacer"></span><button class="btn danger auto" id="regen">Generar nuevo QR</button></div>
    <p class="muted small">Si el alumno perdió su carné, genere un nuevo QR: el anterior dejará de funcionar.</p>`, (root) => {
    $('#copy', root).addEventListener('click', () => navigator.clipboard.writeText(c.portal_url).then(() => toast('Enlace copiado')));
    $('#regen', root).addEventListener('click', async () => {
      if (!confirm('¿Invalidar el QR actual y generar uno nuevo?')) return;
      await api(`/students/${s.id}/regenerate-qr`, { method: 'POST' });
      showQr(s);
    });
  });
}

function importForm(sections, sectionId) {
  openModal('Importar alumnos', `
    <form id="imf">
      <label>Grado y sección<select name="section_id" required>${options(sections, 'id', sectionLabel, sectionId, 'Seleccione…')}</select></label>
      <label>Pegue la lista (una fila por alumno, separada por ; o , ) — puede copiarla desde Excel
        <textarea name="csv" required placeholder="Apellidos;Nombres;DNI;Apoderado;WhatsApp&#10;García Pérez;Ana;70000001;Rosa Pérez;+51987654321"></textarea></label>
      <div class="row"><span class="spacer"></span><button class="btn primary auto" type="submit">Importar</button></div>
    </form>`, (root) => {
    onSubmit($('#imf', root), async (d) => {
      d.csv = d.csv.replace(/\t/g, ';');
      const r = await api('/students/import', { method: 'POST', body: d });
      closeModal();
      toast(`${r.created} alumno(s) importados${r.errors.length ? '. Errores: ' + r.errors.join(' | ') : ''}`, r.errors.length > 0);
      route();
    });
  });
}

// ---------- Notificaciones ----------
async function viewNotifications(view) {
  const list = await api('/attendance/notifications');
  view.innerHTML = `
    <div class="page-head"><h1>Notificaciones WhatsApp</h1></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Fecha</th><th>Alumno</th><th>Motivo</th><th>Teléfono</th><th>Estado</th><th>Mensaje</th></tr></thead>
      <tbody>${list.map((n) => `<tr>
        <td class="small">${esc(n.created_at.slice(0, 16))}</td>
        <td>${n.student_id ? `<a href="#/alumno/${n.student_id}">${esc(n.last_name)}, ${esc(n.first_name)}</a>` : '—'}</td>
        <td>${esc(n.reason)}</td>
        <td class="small">${esc(n.phone ? '+' + n.phone : '')}</td>
        <td><span class="badge st-${n.status}" title="${esc(n.error || '')}">${NOTIF[n.status]}</span>${n.error ? `<div class="small error">${esc(n.error)}</div>` : ''}</td>
        <td class="small" style="max-width:420px">${esc(n.body)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Aún no hay notificaciones</td></tr>'}</tbody>
    </table></div>`;
}

// ---------- Estructura: grados, secciones, cursos ----------
async function viewStructure(view) {
  const [grades, sections, courses, users] = await Promise.all([api('/grades'), api('/sections'), api('/courses'), api('/users')]);
  const teachers = users;
  view.innerHTML = `
    <div class="page-head"><h1>Grados, secciones y cursos</h1></div>
    <div class="stack" id="structure">
    <div class="card">
      <div class="page-head"><h2 style="flex:1;margin:0">Grados</h2><button class="btn primary small auto" id="g-new">+ Grado</button></div>
      <div class="table-wrap"><table><thead><tr><th>Grado</th><th>Orden</th><th class="num">Secciones</th><th></th></tr></thead>
      <tbody>${grades.map((g) => `<tr><td>${esc(g.name)}</td><td>${g.sort_order}</td><td class="num">${g.sections}</td>
        <td><button class="btn small" data-g="${g.id}">Editar</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Cree el primer grado</td></tr>'}</tbody></table></div>
    </div>
    <div class="card">
      <div class="page-head"><h2 style="flex:1;margin:0">Secciones</h2><button class="btn primary small auto" id="s-new">+ Sección</button></div>
      <div class="table-wrap"><table><thead><tr><th>Grado</th><th>Sección</th><th>Tutor</th><th class="num">Alumnos</th><th></th></tr></thead>
      <tbody>${sections.map((s) => `<tr><td>${esc(s.grade_name)}</td><td>${esc(s.name)}</td><td>${esc(s.tutor_name || '')}</td><td class="num">${s.students}</td>
        <td><button class="btn small" data-s="${s.id}">Editar</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Sin secciones</td></tr>'}</tbody></table></div>
    </div>
    <div class="card">
      <div class="page-head"><h2 style="flex:1;margin:0">Cursos</h2><button class="btn primary small auto" id="c-new">+ Curso</button></div>
      <p class="muted small">Cada curso tiene su hora de inicio, minutos de tolerancia (después cuenta como tardanza) y minutos tras el inicio en que se cierra la lista y se envía el WhatsApp a los padres.</p>
      <div class="table-wrap"><table><thead><tr><th>Curso</th><th>Grado / Sección</th><th>Docente</th><th>Inicio</th><th class="num">Tolerancia</th><th class="num">Notificar a los</th><th></th></tr></thead>
      <tbody>${courses.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.grade_name)} "${esc(c.section_name)}"</td><td>${esc(c.teacher_name || '—')}</td>
        <td>${esc(c.start_time)}</td><td class="num">${c.late_tolerance_min} min</td><td class="num">${c.notify_after_min} min</td>
        <td><button class="btn small" data-c="${c.id}">Editar</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">Sin cursos</td></tr>'}</tbody></table></div>
    </div></div>`;

  const crud = (path, item, title, fields) => openModal(title, `<form id="cf">${fields}
      <div class="row">${item.id ? '<button type="button" class="btn danger auto" id="del">Eliminar</button>' : ''}<span class="spacer"></span>
      <button class="btn primary auto" type="submit">Guardar</button></div></form>`, (root) => {
    onSubmit($('#cf', root), async (d) => {
      await api(item.id ? `${path}/${item.id}` : path, { method: item.id ? 'PUT' : 'POST', body: d });
      closeModal();
      route();
    });
    const del = $('#del', root);
    if (del) del.addEventListener('click', async () => {
      if (!confirm('¿Eliminar? Se eliminarán también sus registros dependientes.')) return;
      try { await api(`${path}/${item.id}`, { method: 'DELETE' }); closeModal(); route(); } catch (e) { toast(e.message, true); }
    });
  });

  const gradeForm = (g = {}) => crud('/grades', g, g.id ? 'Editar grado' : 'Nuevo grado', `
    <label>Nombre<input name="name" required value="${esc(g.name || '')}" placeholder="Ej. 1ro Primaria"></label>
    <label>Orden<input name="sort_order" type="number" value="${g.sort_order ?? grades.length + 1}"></label>`);
  const sectionForm = (s = {}) => crud('/sections', s, s.id ? 'Editar sección' : 'Nueva sección', `
    <label>Grado<select name="grade_id" required>${options(grades, 'id', (g) => g.name, s.grade_id, 'Seleccione…')}</select></label>
    <label>Sección<input name="name" required value="${esc(s.name || '')}" placeholder="Ej. A"></label>
    <label>Tutor(a)<select name="tutor_id">${options(teachers, 'id', (u) => u.name, s.tutor_id, 'Sin tutor')}</select></label>`);
  const courseForm = (c = {}) => crud('/courses', c, c.id ? 'Editar curso' : 'Nuevo curso', `
    <label>Grado y sección<select name="section_id" required>${options(sections, 'id', sectionLabel, c.section_id, 'Seleccione…')}</select></label>
    <label>Nombre del curso<input name="name" required value="${esc(c.name || '')}" placeholder="Ej. Matemática"></label>
    <label>Docente<select name="teacher_id">${options(teachers, 'id', (u) => u.name, c.teacher_id, 'Sin docente')}</select></label>
    <div class="row">
      <label>Hora de inicio<input name="start_time" type="time" required value="${esc(c.start_time || '08:00')}"></label>
      <label>Tolerancia (min)<input name="late_tolerance_min" type="number" min="0" value="${c.late_tolerance_min ?? 10}"></label>
      <label>Notificar tras (min)<input name="notify_after_min" type="number" min="0" value="${c.notify_after_min ?? 30}"></label>
    </div>`);

  $('#g-new').onclick = () => gradeForm();
  $('#s-new').onclick = () => sectionForm();
  $('#c-new').onclick = () => courseForm();
  $('#structure').addEventListener('click', (e) => {
    const b = e.target.closest('[data-g],[data-s],[data-c]');
    if (!b) return;
    if (b.dataset.g) gradeForm(grades.find((x) => String(x.id) === b.dataset.g));
    if (b.dataset.s) sectionForm(sections.find((x) => String(x.id) === b.dataset.s));
    if (b.dataset.c) courseForm(courses.find((x) => String(x.id) === b.dataset.c));
  });
}

// ---------- Usuarios ----------
async function viewUsers(view) {
  const users = await api('/users');
  view.innerHTML = `
    <div class="page-head"><h1>Usuarios</h1><button class="btn primary auto" id="new">+ Nuevo usuario</button></div>
    <div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Teléfono</th><th></th></tr></thead>
    <tbody>${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.role === 'admin' ? 'Administrador' : 'Docente'}</td>
      <td>${esc(u.phone || '')}</td><td><button class="btn small" data-u="${u.id}">Editar</button></td></tr>`).join('')}</tbody></table></div>`;
  const form = (u = {}) => openModal(u.id ? 'Editar usuario' : 'Nuevo usuario', `
    <form id="uf">
      <label>Nombre<input name="name" required value="${esc(u.name || '')}"></label>
      <label>Correo<input name="email" type="email" required value="${esc(u.email || '')}"></label>
      <label>Teléfono<input name="phone" value="${esc(u.phone || '')}"></label>
      <label>Rol<select name="role"><option value="teacher">Docente</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrador</option></select></label>
      <label>${u.id ? 'Nueva contraseña (dejar vacío para no cambiar)' : 'Contraseña'}<input name="password" type="password" minlength="6" ${u.id ? '' : 'required'}></label>
      <div class="row">${u.id ? '<button type="button" class="btn danger auto" id="del">Eliminar</button>' : ''}<span class="spacer"></span>
      <button class="btn primary auto" type="submit">Guardar</button></div>
    </form>`, (root) => {
    onSubmit($('#uf', root), async (d) => {
      await api(u.id ? `/users/${u.id}` : '/users', { method: u.id ? 'PUT' : 'POST', body: d });
      closeModal();
      route();
    });
    const del = $('#del', root);
    if (del) del.addEventListener('click', async () => {
      if (!confirm('¿Eliminar usuario?')) return;
      try { await api(`/users/${u.id}`, { method: 'DELETE' }); closeModal(); route(); } catch (e) { toast(e.message, true); }
    });
  });
  $('#new').onclick = () => form();
  view.querySelector('tbody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-u]');
    if (b) form(users.find((x) => String(x.id) === b.dataset.u));
  });
}

// ---------- Configuración ----------
async function viewConfig(view) {
  const s = await api('/settings');
  view.innerHTML = `
    <div class="page-head"><h1>Configuración</h1></div>
    <form id="f" class="card stack">
      <div class="row">
        <label>Nombre del colegio<input name="school_name" required value="${esc(s.school_name)}"></label>
        <label>Zona horaria (IANA)<input name="timezone" required value="${esc(s.timezone)}" placeholder="America/Lima"></label>
      </div>
      <label>URL pública de la aplicación (para los enlaces del portal)<input name="public_url" value="${esc(s.public_url)}" placeholder="https://asistencia.micolegio.edu"></label>
      <p class="small">Proveedor de WhatsApp activo: <b>${esc(s.whatsapp_provider)}</b>${s.whatsapp_provider === 'simulado' ? ' — los mensajes se registran pero no se envían. Configure las variables de entorno para Meta o Twilio (ver README).' : ''}</p>
      <div class="row">
        <label class="check auto"><input type="checkbox" name="notify_absent" ${s.notify_absent === '1' ? 'checked' : ''}> Notificar faltas</label>
        <label class="check auto"><input type="checkbox" name="notify_late" ${s.notify_late === '1' ? 'checked' : ''}> Notificar tardanzas</label>
      </div>
      <p class="muted small">Variables disponibles: {apoderado} {alumno} {grado} {seccion} {curso} {fecha} {hora} {hora_registro} {colegio}. En mensajes: {tipo} {titulo} {contenido} {entrega} {profesor}.</p>
      <label>Mensaje de falta<textarea name="template_absent">${esc(s.template_absent)}</textarea></label>
      <label>Mensaje de tardanza<textarea name="template_late">${esc(s.template_late)}</textarea></label>
      <label>Mensaje de tarea / comentario<textarea name="template_message">${esc(s.template_message)}</textarea></label>
      <div class="row"><span class="spacer"></span><button class="btn primary auto" type="submit">Guardar</button></div>
    </form>`;
  onSubmit($('#f'), async (d) => {
    await api('/settings', { method: 'PUT', body: d });
    toast('Configuración guardada');
    boot();
  });
}

// ---------- Mi cuenta ----------
async function viewAccount(view) {
  view.innerHTML = `
    <div class="page-head"><h1>Mi cuenta</h1></div>
    <form id="f" class="card" style="max-width:420px">
      <p><b>${esc(state.user.name)}</b><br><span class="muted">${esc(state.user.email)}</span></p>
      <label>Contraseña actual<input type="password" name="current" required></label>
      <label>Nueva contraseña<input type="password" name="password" minlength="6" required></label>
      <button class="btn primary" type="submit" style="margin-top:.75rem">Cambiar contraseña</button>
    </form>`;
  onSubmit($('#f'), async (d, form) => {
    await api('/auth/password', { method: 'POST', body: d });
    form.reset();
    toast('Contraseña actualizada');
  });
}

boot();
