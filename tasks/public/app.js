/* FiqStudio Tasks: client app. Data lives in Cloudflare D1 through /api/{tasks,projects,clients}. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const STATUS = [['todo', 'To Do', 'var(--st-todo)'], ['in_progress', 'In Progress', 'var(--st-prog)'], ['blocked', 'Blocked', 'var(--st-block)'], ['completed', 'Done', 'var(--st-done)']];
  const PRIORITY = [['urgent', 'Urgent'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']];
  const PSTATUS = [['planning', 'Planning'], ['active', 'Active'], ['on_hold', 'On hold'], ['completed', 'Completed'], ['cancelled', 'Cancelled']];
  const CSTATUS = [['active', 'Active'], ['inactive', 'Inactive'], ['archived', 'Archived']];
  const lab = (list, v) => (list.find((x) => x[0] === v) || [v, v || ''])[1];
  const isOpen = (t) => t.status !== 'completed' && t.status !== 'cancelled';

  const S = { view: 'focus', col: 'todo', project: '', tasks: [], projects: [], clients: [], loaded: false, error: '' };
  try { S.project = localStorage.getItem('fqt_project') || ''; } catch (e) {}

  // ---------- Dates (local calendar) ----------
  const iso = (d) => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); };
  const today = () => iso(new Date());
  const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
  const dayDiff = (a) => Math.round((new Date(a + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 864e5);
  const fmt = (a) => new Date(a + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  function dueHtml(t) {
    if (!t.due_date) return '';
    const d = String(t.due_date).slice(0, 10), diff = dayDiff(d);
    if (isOpen(t) && diff < 0) return `<span class="due late">${-diff}d late</span>`;
    if (isOpen(t) && diff === 0) return `<span class="due today">Today</span>`;
    if (isOpen(t) && diff === 1) return `<span class="due">Tomorrow</span>`;
    return `<span class="due">${fmt(d)}</span>`;
  }
  const prio = (p) => `<span class="prio p-${esc(p)}" title="${esc(lab(PRIORITY, p))} priority" aria-label="${esc(lab(PRIORITY, p))} priority"><i></i><i></i><i></i></span>`;
  const checkSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';

  // ---------- API ----------
  async function api(path, opts = {}) {
    let res;
    try { res = await fetch(path, { cache: 'no-store', ...opts, headers: { 'Content-Type': 'application/json' } }); }
    catch (e) { throw new Error('No connection. Check your internet and try again'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.status === 401 ? 'Your sign-in expired. Reload the page to sign in again' : (data.error || 'Request failed (' + res.status + ')'));
    return data;
  }
  async function load() {
    try {
      const [t, p, c] = await Promise.all([api('/api/tasks'), api('/api/projects'), api('/api/clients')]);
      S.tasks = t.data || []; S.projects = p.data || []; S.clients = c.data || []; S.loaded = true; S.error = '';
      if (S.project && !S.projects.some((x) => x.id === S.project)) S.project = '';
    } catch (e) { S.error = e.message; }
    render();
  }
  let toastTimer;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400); }

  // ---------- Rendering ----------
  const visibleTasks = () => S.tasks.filter((t) => t.status !== 'cancelled' && (!S.project || t.project_id === S.project));
  function meta(t) { return [t.project_name, t.client_name].filter(Boolean).map(esc).join(' · '); }

  function row(t) {
    const done = t.status === 'completed';
    return `<div class="row${done ? ' done' : ''}">
      <button class="check${done ? ' on' : ''}" type="button" data-toggle="${esc(t.id)}" aria-label="${done ? 'Mark not done' : 'Mark done'}: ${esc(t.title)}"><i>${done ? checkSvg : ''}</i></button>
      <button class="row-main" type="button" data-task="${esc(t.id)}"><b>${esc(t.title)}</b>${meta(t) ? `<small>${meta(t)}</small>` : ''}</button>
      <div class="row-meta">${t.status === 'in_progress' ? '<span class="chip acc">In progress</span>' : t.status === 'blocked' ? '<span class="chip warn">Blocked</span>' : ''}${isOpen(t) ? prio(t.priority) : ''}${dueHtml(t)}</div>
    </div>`;
  }
  function group(title, color, list, emptyText) {
    if (!list.length && !emptyText) return '';
    return `<section class="group" style="--c:${color}"><div class="group-h"><h3><i></i>${esc(title)}</h3><span>${list.length}</span></div>
      ${list.length ? list.map(row).join('') : `<p class="sub" style="margin:0;padding:4px 12px 12px;color:var(--mute);font-size:14px">${esc(emptyText)}</p>`}</section>`;
  }
  function empty(title, text) { return `<div class="empty"><b>${esc(title)}</b><p>${esc(text)}</p></div>`; }

  function renderFocus() {
    const open = visibleTasks().filter(isOpen), td = today(), wk = addDays(7);
    if (!S.tasks.length) return empty('No tasks yet', 'Type a task in the box above and press Enter.');
    const late = open.filter((t) => t.due_date && t.due_date.slice(0, 10) < td);
    const now = open.filter((t) => t.due_date && t.due_date.slice(0, 10) === td);
    const doing = open.filter((t) => t.status === 'in_progress' && !late.includes(t) && !now.includes(t));
    const week = open.filter((t) => t.due_date && t.due_date.slice(0, 10) > td && t.due_date.slice(0, 10) <= wk && !doing.includes(t));
    const later = open.filter((t) => !late.includes(t) && !now.includes(t) && !doing.includes(t) && !week.includes(t));
    const doneToday = visibleTasks().filter((t) => t.status === 'completed' && String(t.updated_at || '').slice(0, 10) === new Date().toISOString().slice(0, 10));
    return group('Overdue', 'var(--bad)', late) + group('Today', 'var(--acc)', now, late.length ? '' : 'Nothing due today.') +
      group('In progress', 'var(--st-prog)', doing) + group('Next 7 days', 'var(--st-block)', week) + group('Later / no date', 'var(--st-todo)', later) +
      group('Done today', 'var(--st-done)', doneToday);
  }

  function renderBoard() {
    const list = visibleTasks();
    const tabs = `<div class="coltabs" role="tablist">${STATUS.map(([k, n]) => `<button type="button" role="tab" data-col="${k}" class="${k === S.col ? 'on' : ''}" aria-selected="${k === S.col}">${n} ${list.filter((t) => t.status === k).length}</button>`).join('')}</div>`;
    const cols = STATUS.map(([k, n, c]) => {
      const items = list.filter((t) => t.status === k);
      const shown = k === 'completed' ? items.slice(0, 30) : items;
      return `<div class="col${k === S.col ? ' on' : ''}" style="--c:${c}"><div class="col-h"><i></i>${n}<span>${items.length}</span></div>
        ${!S.tasks.length && k === 'todo' ? '<p class="hint">Add your first task with the box above.</p>' : ''}
        ${shown.map((t) => `<button class="card" type="button" data-task="${esc(t.id)}"><b>${esc(t.title)}</b>${meta(t) ? `<small>${meta(t)}</small>` : ''}
          <span class="card-meta">${isOpen(t) ? prio(t.priority) : ''}${dueHtml(t)}</span></button>`).join('')}
        ${k === 'completed' && items.length > 30 ? `<p class="hint">Showing the latest 30 of ${items.length}.</p>` : ''}</div>`;
    }).join('');
    return tabs + `<div class="board">${cols}</div>`;
  }

  function renderProjects() {
    if (!S.projects.length) return empty('No projects yet', 'Use + New project to add one, then link tasks to it.');
    return `<div class="grid">${S.projects.map((p) => {
      const ts = S.tasks.filter((t) => t.project_id === p.id && t.status !== 'cancelled');
      const done = ts.filter((t) => t.status === 'completed').length, pct = ts.length ? Math.round(done / ts.length * 100) : 0;
      const chip = p.status === 'completed' ? 'ok' : p.status === 'active' ? 'acc' : p.status === 'on_hold' ? 'warn' : '';
      return `<button class="pcard" type="button" data-project="${esc(p.id)}">
        <span class="pcard-h"><span><b>${esc(p.project_name)}</b><small>${esc(p.client_name || 'No client')}</small></span><span class="chip ${chip}">${esc(lab(PSTATUS, p.status))}</span></span>
        <span><span class="prog"><span>${done} of ${ts.length} tasks done</span><b>${pct}%</b></span><span class="bar${pct === 100 ? ' k' : ''}"><i style="width:${pct}%"></i></span></span>
        <span class="pcard-f">${prio(p.priority)}${p.due_date ? dueHtml({ ...p, status: p.status === 'completed' ? 'completed' : 'todo' }) : '<span class="due">No deadline</span>'}</span>
      </button>`;
    }).join('')}</div>`;
  }

  function renderClients() {
    if (!S.clients.length) return empty('No clients yet', 'Use + New client to add one, then link projects to them.');
    return `<section class="group">${S.clients.map((c) => {
      const n = S.projects.filter((p) => p.client_id === c.id).length;
      const contact = [c.email, c.phone].filter(Boolean).map(esc).join(' · ');
      return `<div class="row"><span class="avatar" aria-hidden="true">${esc((c.client_name || '?').trim().slice(0, 2).toUpperCase())}</span>
        <button class="row-main" type="button" data-client="${esc(c.id)}"><b>${esc(c.client_name)}${c.business_name ? ` <span style="font-weight:400;color:var(--mute)">· ${esc(c.business_name)}</span>` : ''}</b><small>${contact || 'No contact details yet'}</small></button>
        <div class="row-meta"><span class="due">${n} project${n === 1 ? '' : 's'}</span><span class="chip ${c.status === 'active' ? 'ok' : ''}">${esc(lab(CSTATUS, c.status))}</span></div></div>`;
    }).join('')}</section>`;
  }

  function renderStats() {
    const open = S.tasks.filter(isOpen), td = today();
    const late = open.filter((t) => t.due_date && t.due_date.slice(0, 10) < td).length;
    const dueToday = open.filter((t) => t.due_date && t.due_date.slice(0, 10) === td).length;
    const doing = open.filter((t) => t.status === 'in_progress').length;
    const activeProjects = S.projects.filter((p) => p.status === 'active' || p.status === 'planning').length;
    $('#stats').innerHTML = [['Open tasks', open.length], ['Due today', dueToday], ['Overdue', late, late ? 'bad' : ''], [S.view === 'projects' || S.view === 'clients' ? 'Active projects' : 'In progress', S.view === 'projects' || S.view === 'clients' ? activeProjects : doing]]
      .map(([l, v, c]) => `<div><span>${l}</span><b class="${c || ''}">${v}</b></div>`).join('');
  }

  function render() {
    document.querySelectorAll('#tabs a').forEach((a) => { const on = a.dataset.view === S.view; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    $('#newBtn').textContent = S.view === 'projects' ? '+ New project' : S.view === 'clients' ? '+ New client' : '+ New task';
    $('#toolbar').hidden = S.view === 'projects' || S.view === 'clients';
    const sel = $('#projectFilter');
    sel.innerHTML = `<option value="">All projects</option>` + S.projects.map((p) => `<option value="${esc(p.id)}"${p.id === S.project ? ' selected' : ''}>${esc(p.project_name)}</option>`).join('');
    renderStats();
    const v = $('#view');
    if (S.error && !S.loaded) { v.innerHTML = empty('Could not load your tasks', S.error); return; }
    if (!S.loaded) { v.innerHTML = empty('Loading…', 'Getting your tasks, projects and clients.'); return; }
    v.innerHTML = S.view === 'board' ? renderBoard() : S.view === 'projects' ? renderProjects() : S.view === 'clients' ? renderClients() : renderFocus();
    document.title = (S.view === 'focus' ? 'Focus' : S.view[0].toUpperCase() + S.view.slice(1)) + ' · FiqStudio Tasks';
  }

  // ---------- Sheet (create / edit) ----------
  let onSubmit = null;
  function field(f) {
    const id = 'f_' + f.name;
    if (f.type === 'seg') {
      return `<div><span style="display:block;font-weight:600;font-size:13px;margin-bottom:6px" id="${id}_l">${esc(f.label)}</span>
        <div class="seg" role="group" aria-labelledby="${id}_l" data-seg="${f.name}">${f.options.map(([v, t]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${v === f.value}">${esc(t)}</button>`).join('')}</div>
        <input type="hidden" id="${id}" value="${esc(f.value)}"></div>`;
    }
    const lbl = `${esc(f.label)}${f.required ? ' *' : ''}`;
    if (f.type === 'select') return `<label for="${id}">${lbl}<select id="${id}">${f.options.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(f.value || '') ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
    if (f.type === 'textarea') return `<label for="${id}">${lbl}<textarea id="${id}" maxlength="5000">${esc(f.value || '')}</textarea></label>`;
    return `<label for="${id}">${lbl}<input id="${id}" type="${f.type || 'text'}" value="${esc(f.value || '')}" maxlength="${f.max || 250}"${f.required ? ' required' : ''}></label>`;
  }
  function openSheet({ title, fields, save, remove }) {
    $('#sheetTitle').textContent = title;
    const rows = []; let pair = [];
    fields.forEach((f) => { if (f.half) { pair.push(field(f)); if (pair.length === 2) { rows.push(`<div class="two">${pair.join('')}</div>`); pair = []; } } else { if (pair.length) { rows.push(`<div class="two">${pair.join('')}</div>`); pair = []; } rows.push(field(f)); } });
    if (pair.length) rows.push(`<div class="two">${pair.join('')}</div>`);
    $('#sheetFields').innerHTML = rows.join('');
    const err = $('#sheetError'); err.hidden = true;
    const del = $('#sheetDelete'); del.hidden = !remove; del.textContent = 'Delete'; delete del.dataset.armed;
    del.onclick = remove ? async () => {
      if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'Tap again to delete'; return; }
      try { await remove(); closeSheet(); } catch (e) { err.textContent = e.message; err.hidden = false; }
    } : null;
    onSubmit = async () => {
      const vals = {};
      fields.forEach((f) => { vals[f.name] = ($('#f_' + f.name).value || '').trim(); });
      const miss = fields.find((f) => f.required && !vals[f.name]);
      if (miss) { err.textContent = miss.label + ' is required'; err.hidden = false; $('#f_' + miss.name).focus(); return; }
      try { await save(vals); closeSheet(); } catch (e) { err.textContent = e.message; err.hidden = false; }
    };
    $('#sheet').hidden = false;
    setTimeout(() => { const f = $('#sheetFields input:not([type=hidden]),#sheetFields select,#sheetFields textarea'); if (f) f.focus(); }, 40);
  }
  function closeSheet() { $('#sheet').hidden = true; onSubmit = null; }
  $('#sheetForm').addEventListener('submit', async (e) => { e.preventDefault(); if (!onSubmit) return; const b = $('#sheetSave'); b.disabled = true; try { await onSubmit(); } finally { b.disabled = false; } });
  $('#sheet').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { closeSheet(); return; }
    const sb = e.target.closest('[data-seg] button');
    if (sb) { const g = sb.closest('[data-seg]'); g.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === sb))); $('#f_' + g.dataset.seg).value = sb.dataset.v; }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  const nul = (v) => (v === '' ? null : v);
  const projectOpts = () => [['', 'No project'], ...S.projects.map((p) => [p.id, p.project_name])];
  const clientOpts = () => [['', 'No client'], ...S.clients.map((c) => [c.id, c.client_name])];

  function taskSheet(t) {
    openSheet({
      title: t ? 'Edit task' : 'New task',
      fields: [
        { name: 'title', label: 'Task', required: true, value: t ? t.title : '' },
        { name: 'status', label: 'Status', type: 'seg', options: STATUS.map((s) => [s[0], s[1]]), value: t ? (t.status === 'cancelled' ? 'todo' : t.status) : 'todo' },
        { name: 'priority', label: 'Priority', type: 'seg', options: PRIORITY, value: t ? t.priority : 'medium' },
        { name: 'project_id', label: 'Project', type: 'select', options: projectOpts(), value: t ? t.project_id : S.project, half: true },
        { name: 'due_date', label: 'Due date', type: 'date', value: t && t.due_date ? t.due_date.slice(0, 10) : '', half: true },
        { name: 'description', label: 'Notes', type: 'textarea', value: t ? t.description : '' }
      ],
      save: async (v) => {
        const body = { ...v, project_id: nul(v.project_id), due_date: nul(v.due_date), description: nul(v.description) };
        if (t) await api('/api/tasks/' + encodeURIComponent(t.id), { method: 'PATCH', body: JSON.stringify(body) });
        else await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
        toast(t ? 'Task saved' : 'Task added'); await load();
      },
      remove: t ? async () => { await api('/api/tasks/' + encodeURIComponent(t.id), { method: 'DELETE' }); toast('Task deleted'); await load(); } : null
    });
  }
  function projectSheet(p) {
    openSheet({
      title: p ? 'Edit project' : 'New project',
      fields: [
        { name: 'project_name', label: 'Project name', required: true, value: p ? p.project_name : '', max: 200 },
        { name: 'client_id', label: 'Client', type: 'select', options: clientOpts(), value: p ? p.client_id : '', half: true },
        { name: 'due_date', label: 'Deadline', type: 'date', value: p && p.due_date ? p.due_date.slice(0, 10) : '', half: true },
        { name: 'status', label: 'Status', type: 'seg', options: PSTATUS, value: p ? p.status : 'active' },
        { name: 'priority', label: 'Priority', type: 'seg', options: PRIORITY, value: p ? p.priority : 'medium' },
        { name: 'description', label: 'Notes', type: 'textarea', value: p ? p.description : '' }
      ],
      save: async (v) => {
        const body = { ...v, client_id: nul(v.client_id), due_date: nul(v.due_date), description: nul(v.description) };
        if (p) await api('/api/projects/' + encodeURIComponent(p.id), { method: 'PATCH', body: JSON.stringify(body) });
        else await api('/api/projects', { method: 'POST', body: JSON.stringify(body) });
        toast(p ? 'Project saved' : 'Project added'); await load();
      },
      remove: p ? async () => { await api('/api/projects/' + encodeURIComponent(p.id), { method: 'DELETE' }); toast('Project deleted. Its tasks were kept'); await load(); } : null
    });
  }
  function clientSheet(c) {
    openSheet({
      title: c ? 'Edit client' : 'New client',
      fields: [
        { name: 'client_name', label: 'Client name', required: true, value: c ? c.client_name : '', max: 200 },
        { name: 'business_name', label: 'Business name', value: c ? c.business_name : '', max: 200 },
        { name: 'email', label: 'Email', type: 'email', value: c ? c.email : '', half: true, max: 254 },
        { name: 'phone', label: 'Phone', type: 'tel', value: c ? c.phone : '', half: true, max: 50 },
        { name: 'status', label: 'Status', type: 'seg', options: CSTATUS, value: c ? c.status : 'active' },
        { name: 'notes', label: 'Notes', type: 'textarea', value: c ? c.notes : '' }
      ],
      save: async (v) => {
        const body = { ...v, business_name: nul(v.business_name), email: nul(v.email), phone: nul(v.phone), notes: nul(v.notes) };
        if (c) await api('/api/clients/' + encodeURIComponent(c.id), { method: 'PATCH', body: JSON.stringify(body) });
        else await api('/api/clients', { method: 'POST', body: JSON.stringify(body) });
        toast(c ? 'Client saved' : 'Client added'); await load();
      },
      remove: c ? async () => { await api('/api/clients/' + encodeURIComponent(c.id), { method: 'DELETE' }); toast('Client deleted. Their projects were kept'); await load(); } : null
    });
  }

  // ---------- Events ----------
  function route() {
    const h = location.hash.slice(1);
    S.view = ['focus', 'board', 'projects', 'clients'].includes(h) ? h : 'focus';
    render();
  }
  window.addEventListener('hashchange', route);
  $('#newBtn').addEventListener('click', () => { if (!S.loaded) return; if (S.view === 'projects') projectSheet(null); else if (S.view === 'clients') clientSheet(null); else taskSheet(null); });
  $('#projectFilter').addEventListener('change', (e) => { S.project = e.target.value; try { localStorage.setItem('fqt_project', S.project); } catch (err) {} render(); });
  $('#quickAdd').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = $('#quickTitle'), title = inp.value.trim();
    if (!title || !S.loaded) return;
    inp.disabled = true;
    try { await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title, project_id: S.project || null, status: 'todo' }) }); inp.value = ''; toast('Task added'); await load(); }
    catch (err) { toast(err.message); }
    finally { inp.disabled = false; inp.focus(); }
  });
  $('#view').addEventListener('click', async (e) => {
    const col = e.target.closest('[data-col]'); if (col) { S.col = col.dataset.col; render(); return; }
    const tg = e.target.closest('[data-toggle]');
    if (tg) {
      const t = S.tasks.find((x) => x.id === tg.dataset.toggle); if (!t) return;
      const next = t.status === 'completed' ? 'todo' : 'completed';
      t.status = next; t.updated_at = new Date().toISOString(); render();
      try { await api('/api/tasks/' + encodeURIComponent(t.id), { method: 'PATCH', body: JSON.stringify({ status: next }) }); toast(next === 'completed' ? 'Done. Nice work' : 'Moved back to To Do'); }
      catch (err) { toast(err.message); }
      load(); return;
    }
    const tk = e.target.closest('[data-task]'); if (tk) { const t = S.tasks.find((x) => x.id === tk.dataset.task); if (t) taskSheet(t); return; }
    const pj = e.target.closest('[data-project]'); if (pj) { const p = S.projects.find((x) => x.id === pj.dataset.project); if (p) projectSheet(p); return; }
    const cl = e.target.closest('[data-client]'); if (cl) { const c = S.clients.find((x) => x.id === cl.dataset.client); if (c) clientSheet(c); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.loaded) load(); });

  $('#today').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  route();
  load();
})();
