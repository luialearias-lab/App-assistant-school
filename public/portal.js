'use strict';
/* Portal de solo lectura para padres y alumnos: récord mensual y tareas/comentarios. */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = { present: 'Presente', late: 'Tarde', absent: 'Falta', justified: 'Justificada' };
const fmtDate = (d) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');

const params = new URLSearchParams(location.search);
const code = (params.get('c') || '').trim().toUpperCase();
const app = document.getElementById('app');

if (!code) {
  const f = document.getElementById('code-form');
  f.classList.remove('hidden');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    location.search = '?c=' + encodeURIComponent(f.c.value.trim().toUpperCase());
  });
} else {
  load(params.get('mes'));
}

async function load(month) {
  app.innerHTML = '<p class="muted">Cargando…</p>';
  const res = await fetch(`/api/portal/${encodeURIComponent(code)}${month ? '?month=' + month : ''}`);
  const r = await res.json().catch(() => ({}));
  if (!res.ok) {
    app.innerHTML = `<div class="card"><p class="error">${esc(r.error || 'No se pudo cargar')}</p><a href="/portal.html">Intentar con otro código</a></div>`;
    return;
  }
  document.getElementById('school').textContent = r.school_name;
  document.title = `${r.student.first_name} - ${r.school_name}`;
  document.getElementById('who').textContent = `${r.student.first_name} ${r.student.last_name} · ${r.student.grade_name} "${r.student.section_name}"`;
  const t = r.totals;
  const tasks = r.messages.filter((m) => m.kind === 'task');
  const comments = r.messages.filter((m) => m.kind === 'comment');
  const msgHtml = (m) => `
    <div class="card msg ${m.kind}">
      <b>${esc(m.title)}</b>
      <div class="muted small">${esc(m.author_name || '')} · ${fmtDate(m.created_at)}${m.due_date ? ` · <b>Entrega: ${fmtDate(m.due_date)}</b>` : ''}</div>
      <p>${esc(m.body)}</p>
    </div>`;
  app.innerHTML = `
    <div class="card stack">
      <div class="row"><h2 style="margin:0">Asistencia del mes</h2>
        <input type="month" id="mes" value="${esc(r.month)}" class="auto" style="max-width:180px"></div>
      <div class="stats">
        <div class="stat st-present"><b>${t.present}</b><span>Presente</span></div>
        <div class="stat st-late"><b>${t.late}</b><span>Tarde</span></div>
        <div class="stat st-absent"><b>${t.absent}</b><span>Faltas</span></div>
        <div class="stat st-justified"><b>${t.justified}</b><span>Justificadas</span></div>
        <div class="stat st-pending"><b>${t.rate ?? '—'}${t.rate !== null ? '%' : ''}</b><span>Asistencia</span></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Fecha</th><th>Curso</th><th>Estado</th><th>Hora</th></tr></thead>
        <tbody>${r.records.filter((x) => x.status !== 'present').map((x) => `<tr><td>${fmtDate(x.date)}</td><td>${esc(x.course_name)}</td>
          <td><span class="badge st-${x.status}">${STATUS[x.status]}</span></td><td>${x.scanned_at ? esc(x.scanned_at.slice(11, 16)) : '—'}</td></tr>`).join('')
          || '<tr><td colspan="4" class="empty">Sin faltas ni tardanzas este mes 🎉</td></tr>'}</tbody>
      </table></div>
    </div>
    <h2>📝 Tareas</h2>
    ${tasks.map(msgHtml).join('') || '<div class="card empty">No hay tareas</div>'}
    <h2>💬 Comentarios del profesor</h2>
    ${comments.map(msgHtml).join('') || '<div class="card empty">No hay comentarios</div>'}`;
  document.getElementById('mes').addEventListener('change', (e) => {
    const p = new URLSearchParams(location.search);
    p.set('mes', e.target.value);
    history.replaceState(null, '', '?' + p);
    load(e.target.value);
  });
}
