/* FiqStudio Task Manager: Tasks, Projects and Clients stored in Cloudflare D1 (/api/tasks, /api/projects, /api/clients).
   Loaded after index.html's main script; uses its globals: escapeHtml, showToast, SERVER_PROXY, activeView. */
(function () {
  'use strict';
  const esc = (s) => escapeHtml(s == null ? '' : s);
  const $ = (id) => document.getElementById(id);

  const TASK_STATUS = [['todo', 'To Do'], ['in_progress', 'In Progress'], ['blocked', 'Blocked'], ['completed', 'Done'], ['cancelled', 'Cancelled']];
  const PROJECT_STATUS = [['planning', 'Planning'], ['active', 'Active'], ['on_hold', 'On Hold'], ['completed', 'Completed'], ['cancelled', 'Cancelled']];
  const CLIENT_STATUS = [['active', 'Active'], ['inactive', 'Inactive'], ['archived', 'Archived']];
  const PRIORITY = [['urgent', 'Urgent'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']];
  const label = (list, v) => (list.find((x) => x[0] === v) || [v, v || '-'])[1];
  const isOpen = (t) => t.status !== 'completed' && t.status !== 'cancelled';
  const todayIso = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const fmtDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso.slice(0, 10) + 'T00:00:00');
    return isNaN(d) ? esc(iso) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };
  const daysLate = (iso) => Math.round((new Date(todayIso()) - new Date(String(iso).slice(0, 10))) / 864e5);

  const TM = { tab: 'tasks', filter: 'open', tasks: [], projects: [], clients: [], loaded: false, loading: false, error: '' };

  async function api(path, opts = {}) {
    const res = await fetch(path, { cache: 'no-store', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) throw new Error('Your login expired. Reload the page to sign in again');
      throw new Error(data.error || 'Request failed (HTTP ' + res.status + ')');
    }
    return data;
  }

  async function load(silent) {
    if (!SERVER_PROXY) { TM.error = 'The Task Manager works on the Cloudflare dashboard only.'; render(); return; }
    TM.loading = true; if (!silent) render();
    try {
      const [t, p, c] = await Promise.all([api('/api/tasks'), api('/api/projects'), api('/api/clients')]);
      TM.tasks = t.data || []; TM.projects = p.data || []; TM.clients = c.data || [];
      TM.loaded = true; TM.error = '';
    } catch (e) {
      TM.error = e.message || 'Could not load tasks';
    } finally {
      TM.loading = false; render();
    }
  }

  // ---------- Small UI pieces ----------
  const pill = (text, tone) => {
    const tones = {
      urgent: 'bg-red-500/15 text-red-700 dark:text-red-300',
      high: 'bg-orange-500/15 text-[#9A3412] dark:text-[#FDBA74]',
      medium: 'bg-amber-500/15 text-amber-800 dark:text-amber-200',
      low: 'bg-white/70 dark:bg-zinc-800 text-[#57534E] dark:text-[#C7B8AC]',
      ok: 'bg-emerald-500/15 text-[#166534] dark:text-[#6EE7B7]',
      muted: 'bg-white/70 dark:bg-zinc-800 text-[#57534E] dark:text-[#C7B8AC]',
      accent: 'bg-orange-500/15 text-[#9A3412] dark:text-[#FDBA74]',
      bad: 'bg-red-500/15 text-red-700 dark:text-red-300'
    };
    return `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${tones[tone] || tones.muted}">${esc(text)}</span>`;
  };
  const dueBadge = (iso, open) => {
    if (!iso) return '';
    const late = open ? daysLate(iso) : 0;
    if (late > 0) return `<span class="text-[11px] font-semibold text-red-700 dark:text-red-300 whitespace-nowrap">${late}d overdue</span>`;
    if (late === 0 && open) return `<span class="text-[11px] font-semibold text-[#9A3412] dark:text-[#FDBA74] whitespace-nowrap">Due today</span>`;
    return `<span class="text-[11px] text-[#57534E] dark:text-[#C7B8AC] whitespace-nowrap">${fmtDate(iso)}</span>`;
  };
  const emptyCard = (title, text) => `
    <div class="glass-surface rounded-2xl p-6 text-center space-y-1.5">
      <p class="font-display text-sm font-bold text-[#1C1917] dark:text-[#F5EFE6]">${esc(title)}</p>
      <p class="text-xs text-[#57534E] dark:text-[#C7B8AC]">${esc(text)}</p>
    </div>`;
  const segClass = (on) => on
    ? 'bg-[#B8431B] text-white shadow-xs'
    : 'text-[#57534E] dark:text-[#D6C9BE] hover:text-slate-900 dark:hover:text-white';

  // ---------- Views ----------
  function renderTasks() {
    const list = TM.tasks.filter((t) => TM.filter === 'all' ? true : TM.filter === 'done' ? !isOpen(t) : isOpen(t));
    if (!TM.tasks.length) return emptyCard('No tasks yet', 'Use + New Task to add your first one.');
    if (!list.length) return emptyCard(TM.filter === 'done' ? 'Nothing finished yet' : 'All clear', TM.filter === 'done' ? 'Completed tasks will show here.' : 'No open tasks. Nice work.');
    const order = ['in_progress', 'todo', 'blocked', 'completed', 'cancelled'];
    return order.map((st) => {
      const rows = list.filter((t) => t.status === st);
      if (!rows.length) return '';
      return `
        <div class="glass-surface rounded-2xl p-3 sm:p-4 space-y-1.5">
          <div class="flex items-center justify-between px-1 pb-1">
            <h3 class="font-display text-sm font-bold text-[#1C1917] dark:text-[#F5EFE6]">${esc(label(TASK_STATUS, st))}</h3>
            <span class="text-[11px] font-semibold text-[#57534E] dark:text-[#C7B8AC]">${rows.length}</span>
          </div>
          ${rows.map(taskRow).join('')}
        </div>`;
    }).join('');
  }

  function taskRow(t) {
    const open = isOpen(t);
    const meta = [t.project_name, t.client_name].filter(Boolean).map(esc).join(' &middot; ');
    return `
      <div class="flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-white/50 dark:hover:bg-zinc-800/50 border border-transparent">
        <button type="button" data-tmgr-toggle="${esc(t.id)}" aria-label="${open ? 'Mark done' : 'Mark not done'}: ${esc(t.title)}" class="w-11 h-11 -m-1.5 shrink-0 flex items-center justify-center cursor-pointer tap-pop">
          <span class="w-5 h-5 rounded-full border-2 flex items-center justify-center ${open ? 'border-[#B8431B]/60' : 'border-emerald-600 bg-emerald-600 text-white'}">
            ${open ? '' : '<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>'}
          </span>
        </button>
        <button type="button" data-tmgr-edit-task="${esc(t.id)}" class="flex-1 min-w-0 text-left cursor-pointer">
          <span class="block text-sm font-semibold truncate ${open ? 'text-[#1C1917] dark:text-[#F5EFE6]' : 'text-[#57534E] dark:text-[#C7B8AC] line-through'}">${esc(t.title)}</span>
          ${meta ? `<span class="block text-[11px] text-[#57534E] dark:text-[#C7B8AC] truncate">${meta}</span>` : ''}
        </button>
        <div class="flex items-center gap-2 shrink-0">
          ${open && (t.priority === 'urgent' || t.priority === 'high') ? pill(label(PRIORITY, t.priority), t.priority) : ''}
          ${dueBadge(t.due_date, open)}
        </div>
      </div>`;
  }

  function renderProjects() {
    if (!TM.projects.length) return emptyCard('No projects yet', 'Use + New Project to add one, then link tasks to it.');
    return `<div class="grid grid-cols-1 md:grid-cols-2 gap-3">${TM.projects.map((p) => {
      const tasks = TM.tasks.filter((t) => t.project_id === p.id);
      const done = tasks.filter((t) => t.status === 'completed').length;
      const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
      const tone = p.status === 'completed' ? 'ok' : p.status === 'active' ? 'accent' : 'muted';
      return `
        <button type="button" data-tmgr-edit-project="${esc(p.id)}" class="glass-surface glass-card-hover rounded-2xl p-4 text-left space-y-2.5 cursor-pointer">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="font-display text-sm font-bold text-[#1C1917] dark:text-[#F5EFE6] truncate">${esc(p.project_name)}</p>
              <p class="text-[11px] text-[#57534E] dark:text-[#C7B8AC] truncate">${esc(p.client_name || 'No client')}</p>
            </div>
            ${pill(label(PROJECT_STATUS, p.status), tone)}
          </div>
          <div class="space-y-1">
            <div class="flex justify-between text-[11px] text-[#57534E] dark:text-[#C7B8AC]"><span>${done} of ${tasks.length} tasks done</span><span class="font-mono font-semibold">${pct}%</span></div>
            <div class="w-full h-1.5 rounded-full bg-slate-900/10 dark:bg-white/10 overflow-hidden"><div class="h-full rounded-full bg-[#B8431B]" style="width:${pct}%"></div></div>
          </div>
          <div class="flex items-center justify-between gap-2">
            ${pill(label(PRIORITY, p.priority), p.priority)}
            ${dueBadge(p.due_date, p.status !== 'completed' && p.status !== 'cancelled')}
          </div>
        </button>`;
    }).join('')}</div>`;
  }

  function renderClients() {
    if (!TM.clients.length) return emptyCard('No clients yet', 'Use + New Client to add one, then link projects to them.');
    return `<div class="glass-surface rounded-2xl p-2 sm:p-3 space-y-1">${TM.clients.map((c) => {
      const projects = TM.projects.filter((p) => p.client_id === c.id).length;
      const contact = [c.email, c.phone].filter(Boolean).map(esc).join(' &middot; ');
      return `
        <button type="button" data-tmgr-edit-client="${esc(c.id)}" class="w-full flex items-center gap-3 px-2 py-2.5 rounded-xl hover:bg-white/50 dark:hover:bg-zinc-800/50 text-left cursor-pointer">
          <span class="w-9 h-9 rounded-xl bg-orange-500/15 text-[#9A3412] dark:text-[#FDBA74] flex items-center justify-center text-xs font-bold shrink-0" aria-hidden="true">${esc((c.client_name || '?').trim().slice(0, 2).toUpperCase())}</span>
          <span class="flex-1 min-w-0">
            <span class="block text-sm font-semibold text-[#1C1917] dark:text-[#F5EFE6] truncate">${esc(c.client_name)}${c.business_name ? ` <span class="font-normal text-[#57534E] dark:text-[#C7B8AC]">&middot; ${esc(c.business_name)}</span>` : ''}</span>
            <span class="block text-[11px] text-[#57534E] dark:text-[#C7B8AC] truncate">${contact || 'No contact details yet'}</span>
          </span>
          <span class="flex items-center gap-2 shrink-0">
            <span class="text-[11px] text-[#57534E] dark:text-[#C7B8AC] hidden sm:inline">${projects} project${projects === 1 ? '' : 's'}</span>
            ${pill(label(CLIENT_STATUS, c.status), c.status === 'active' ? 'ok' : 'muted')}
          </span>
        </button>`;
    }).join('')}</div>`;
  }

  function render() {
    const body = $('tmgrBody');
    if (!body) return;
    document.querySelectorAll('.tmgr-tab').forEach((b) => {
      const on = b.dataset.tmgrTab === TM.tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.className = `tmgr-tab min-h-[36px] px-4 rounded-full cursor-pointer tap-pop transition-colors ${segClass(on)}`;
    });
    document.querySelectorAll('.tmgr-filter').forEach((b) => {
      b.className = `tmgr-filter min-h-[32px] px-3 rounded-full cursor-pointer tap-pop transition-colors ${segClass(b.dataset.tmgrFilter === TM.filter)}`;
    });
    const filters = $('tmgrFilters');
    if (filters) filters.classList.toggle('hidden', TM.tab !== 'tasks');
    const newBtn = $('tmgrNewBtn');
    if (newBtn) newBtn.textContent = TM.tab === 'projects' ? '+ New Project' : TM.tab === 'clients' ? '+ New Client' : '+ New Task';

    const open = TM.tasks.filter(isOpen);
    const late = open.filter((t) => t.due_date && daysLate(t.due_date) > 0).length;
    const sum = $('tmgrSummary');
    if (sum) {
      sum.textContent = TM.error ? TM.error
        : !TM.loaded ? 'Loading your tasks…'
        : `${open.length} open task${open.length === 1 ? '' : 's'}${late ? `, ${late} overdue` : ''} · ${TM.projects.length} project${TM.projects.length === 1 ? '' : 's'} · ${TM.clients.length} client${TM.clients.length === 1 ? '' : 's'}`;
      sum.className = `text-xs mt-0.5 ${TM.error ? 'text-red-700 dark:text-red-300 font-semibold' : 'text-[#57534E] dark:text-[#C7B8AC]'}`;
    }

    if (TM.error && !TM.loaded) { body.innerHTML = emptyCard('Tasks are not available', TM.error); return; }
    if (!TM.loaded) { body.innerHTML = emptyCard('Loading…', 'Fetching tasks, projects and clients.'); return; }
    body.innerHTML = TM.tab === 'projects' ? renderProjects() : TM.tab === 'clients' ? renderClients() : renderTasks();
  }

  // ---------- Modal (create / edit / delete) ----------
  let modalSubmit = null;
  function ensureModal() {
    if ($('tmgrModal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'tmgrModal';
    wrap.className = 'fixed inset-0 z-50 hidden flex items-end sm:items-center justify-center sm:p-4';
    wrap.innerHTML = `
      <div data-tmgr-close class="absolute inset-0 bg-black/55"></div>
      <div class="relative glass-surface rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[92dvh] overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="tmgrModalTitle">
        <div class="px-5 py-4 border-b border-white/60 dark:border-zinc-800 flex items-center justify-between">
          <h3 id="tmgrModalTitle" class="text-sm font-bold text-[#1C1917] dark:text-[#F5EFE6]"></h3>
          <button type="button" data-tmgr-close aria-label="Close" class="w-9 h-9 rounded-full bg-white/60 dark:bg-zinc-800 flex items-center justify-center cursor-pointer">&times;</button>
        </div>
        <form id="tmgrForm" class="p-5 space-y-3.5" novalidate>
          <div id="tmgrFields" class="space-y-3.5"></div>
          <p id="tmgrFormError" class="hidden text-xs font-semibold text-red-700 dark:text-red-300"></p>
          <div class="flex items-center gap-2 pt-1">
            <button type="button" id="tmgrDeleteBtn" class="hidden min-h-[40px] px-4 rounded-full text-xs font-bold text-red-700 dark:text-red-300 hover:bg-red-500/10 cursor-pointer">Delete</button>
            <span class="flex-1"></span>
            <button type="button" data-tmgr-close class="min-h-[40px] px-4 rounded-full border border-white/75 dark:border-zinc-700 text-xs font-semibold cursor-pointer">Cancel</button>
            <button type="submit" id="tmgrSaveBtn" class="min-h-[40px] px-5 rounded-full bg-[#B8431B] hover:bg-[#9A3412] text-white text-xs font-semibold cursor-pointer">Save</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', (e) => { if (e.target.closest('[data-tmgr-close]')) closeModal(); });
    $('tmgrForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!modalSubmit) return;
      const saveBtn = $('tmgrSaveBtn');
      saveBtn.disabled = true;
      try { await modalSubmit(); } finally { saveBtn.disabled = false; }
    });
  }
  const inputCls = 'w-full min-h-[44px] px-3.5 py-2 text-sm rounded-xl border border-white/75 dark:border-zinc-700 bg-white/65 dark:bg-zinc-800/80 focus:border-orange-500';
  function field(f) {
    const id = 'tmgrF_' + f.name;
    const lab = `<label for="${id}" class="block text-xs font-semibold mb-1">${esc(f.label)}${f.required ? ' *' : ''}</label>`;
    if (f.type === 'select') {
      return `<div>${lab}<select id="${id}" class="${inputCls} cursor-pointer">${f.options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(f.value ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`;
    }
    if (f.type === 'textarea') return `<div>${lab}<textarea id="${id}" rows="3" class="${inputCls} py-2.5">${esc(f.value || '')}</textarea></div>`;
    return `<div>${lab}<input id="${id}" type="${f.type || 'text'}" value="${esc(f.value || '')}" ${f.required ? 'required' : ''} class="${inputCls}"></div>`;
  }
  function openModal({ title, fields, onSave, onDelete }) {
    ensureModal();
    $('tmgrModalTitle').textContent = title;
    $('tmgrFields').innerHTML = fields.map(field).join('');
    const err = $('tmgrFormError'); err.classList.add('hidden'); err.textContent = '';
    const del = $('tmgrDeleteBtn');
    del.classList.toggle('hidden', !onDelete);
    del.textContent = 'Delete'; delete del.dataset.armed;
    del.onclick = onDelete ? async () => {
      if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'Click again to delete'; return; }
      try { await onDelete(); closeModal(); } catch (e) { showErr(e.message); }
    } : null;
    modalSubmit = async () => {
      const vals = {};
      fields.forEach((f) => { vals[f.name] = ($('tmgrF_' + f.name).value || '').trim(); });
      const missing = fields.find((f) => f.required && !vals[f.name]);
      if (missing) { showErr(missing.label + ' is required'); $('tmgrF_' + missing.name).focus(); return; }
      try { await onSave(vals); closeModal(); } catch (e) { showErr(e.message); }
    };
    $('tmgrModal').classList.remove('hidden');
    setTimeout(() => { const first = $('tmgrFields').querySelector('input,select,textarea'); if (first) first.focus(); }, 30);
  }
  function showErr(msg) { const err = $('tmgrFormError'); err.textContent = msg || 'Something went wrong'; err.classList.remove('hidden'); }
  function closeModal() { const m = $('tmgrModal'); if (m) m.classList.add('hidden'); modalSubmit = null; }

  const projectOptions = () => [['', 'No project'], ...TM.projects.map((p) => [p.id, p.project_name])];
  const clientOptions = () => [['', 'No client'], ...TM.clients.map((c) => [c.id, c.client_name])];
  const nullIfEmpty = (v) => (v === '' ? null : v);

  function taskModal(t) {
    openModal({
      title: t ? 'Edit task' : 'New task',
      fields: [
        { name: 'title', label: 'Task', required: true, value: t && t.title },
        { name: 'project_id', label: 'Project', type: 'select', options: projectOptions(), value: t ? t.project_id || '' : '' },
        { name: 'status', label: 'Status', type: 'select', options: TASK_STATUS, value: t ? t.status : 'todo' },
        { name: 'priority', label: 'Priority', type: 'select', options: PRIORITY, value: t ? t.priority : 'medium' },
        { name: 'due_date', label: 'Due date', type: 'date', value: t && t.due_date ? t.due_date.slice(0, 10) : '' },
        { name: 'description', label: 'Notes', type: 'textarea', value: t && t.description }
      ],
      onSave: async (v) => {
        const proj = TM.projects.find((p) => p.id === v.project_id);
        const body = { ...v, project_id: nullIfEmpty(v.project_id), client_id: proj ? proj.client_id || null : null, due_date: nullIfEmpty(v.due_date), description: nullIfEmpty(v.description) };
        if (t) await api('/api/tasks/' + encodeURIComponent(t.id), { method: 'PATCH', body: JSON.stringify(body) });
        else await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
        showToast(t ? 'Task saved' : 'Task added');
        await load(true);
      },
      onDelete: t ? async () => { await api('/api/tasks/' + encodeURIComponent(t.id), { method: 'DELETE' }); showToast('Task deleted'); await load(true); } : null
    });
  }
  function projectModal(p) {
    openModal({
      title: p ? 'Edit project' : 'New project',
      fields: [
        { name: 'project_name', label: 'Project name', required: true, value: p && p.project_name },
        { name: 'client_id', label: 'Client', type: 'select', options: clientOptions(), value: p ? p.client_id || '' : '' },
        { name: 'status', label: 'Status', type: 'select', options: PROJECT_STATUS, value: p ? p.status : 'planning' },
        { name: 'priority', label: 'Priority', type: 'select', options: PRIORITY, value: p ? p.priority : 'medium' },
        { name: 'due_date', label: 'Deadline', type: 'date', value: p && p.due_date ? p.due_date.slice(0, 10) : '' },
        { name: 'description', label: 'Notes', type: 'textarea', value: p && p.description }
      ],
      onSave: async (v) => {
        const body = { ...v, client_id: nullIfEmpty(v.client_id), due_date: nullIfEmpty(v.due_date), description: nullIfEmpty(v.description) };
        if (p) await api('/api/projects/' + encodeURIComponent(p.id), { method: 'PATCH', body: JSON.stringify(body) });
        else await api('/api/projects', { method: 'POST', body: JSON.stringify(body) });
        showToast(p ? 'Project saved' : 'Project added');
        await load(true);
      },
      onDelete: p ? async () => { await api('/api/projects/' + encodeURIComponent(p.id), { method: 'DELETE' }); showToast('Project deleted. Its tasks were kept'); await load(true); } : null
    });
  }
  function clientModal(c) {
    openModal({
      title: c ? 'Edit client' : 'New client',
      fields: [
        { name: 'client_name', label: 'Client name', required: true, value: c && c.client_name },
        { name: 'business_name', label: 'Business name', value: c && c.business_name },
        { name: 'client_type', label: 'Type', type: 'select', options: [['business', 'Business'], ['individual', 'Individual']], value: c ? c.client_type : 'business' },
        { name: 'email', label: 'Email', type: 'email', value: c && c.email },
        { name: 'phone', label: 'Phone', type: 'tel', value: c && c.phone },
        { name: 'status', label: 'Status', type: 'select', options: CLIENT_STATUS, value: c ? c.status : 'active' },
        { name: 'notes', label: 'Notes', type: 'textarea', value: c && c.notes }
      ],
      onSave: async (v) => {
        const body = { ...v, business_name: nullIfEmpty(v.business_name), email: nullIfEmpty(v.email), phone: nullIfEmpty(v.phone), notes: nullIfEmpty(v.notes) };
        if (c) await api('/api/clients/' + encodeURIComponent(c.id), { method: 'PATCH', body: JSON.stringify(body) });
        else await api('/api/clients', { method: 'POST', body: JSON.stringify(body) });
        showToast(c ? 'Client saved' : 'Client added');
        await load(true);
      },
      onDelete: c ? async () => { await api('/api/clients/' + encodeURIComponent(c.id), { method: 'DELETE' }); showToast('Client deleted. Their projects were kept'); await load(true); } : null
    });
  }

  // ---------- Events ----------
  document.addEventListener('click', async (e) => {
    const view = document.getElementById('view-tasks');
    if (!view || !view.contains(e.target)) return;
    const tab = e.target.closest('[data-tmgr-tab]');
    if (tab) { TM.tab = tab.dataset.tmgrTab; render(); return; }
    const flt = e.target.closest('[data-tmgr-filter]');
    if (flt) { TM.filter = flt.dataset.tmgrFilter; render(); return; }
    if (e.target.closest('#tmgrNewBtn')) {
      if (!TM.loaded) return;
      if (TM.tab === 'projects') projectModal(null); else if (TM.tab === 'clients') clientModal(null); else taskModal(null);
      return;
    }
    const tog = e.target.closest('[data-tmgr-toggle]');
    if (tog) {
      const t = TM.tasks.find((x) => x.id === tog.dataset.tmgrToggle);
      if (!t) return;
      const next = isOpen(t) ? 'completed' : 'todo';
      t.status = next; render();
      try { await api('/api/tasks/' + encodeURIComponent(t.id), { method: 'PATCH', body: JSON.stringify({ status: next }) }); showToast(next === 'completed' ? 'Marked done' : 'Moved back to To Do'); }
      catch (err) { showToast(err.message); }
      load(true);
      return;
    }
    const et = e.target.closest('[data-tmgr-edit-task]');
    if (et) { const t = TM.tasks.find((x) => x.id === et.dataset.tmgrEditTask); if (t) taskModal(t); return; }
    const ep = e.target.closest('[data-tmgr-edit-project]');
    if (ep) { const p = TM.projects.find((x) => x.id === ep.dataset.tmgrEditProject); if (p) projectModal(p); return; }
    const ec = e.target.closest('[data-tmgr-edit-client]');
    if (ec) { const c = TM.clients.find((x) => x.id === ec.dataset.tmgrEditClient); if (c) clientModal(c); }
  });
  document.addEventListener('keydown', (e) => {
    const m = $('tmgrModal');
    if (e.key === 'Escape' && m && !m.classList.contains('hidden')) closeModal();
  });

  // Called by renderAll() whenever the Tasks view is shown.
  window.renderTasksView = function () {
    render();
    if (!TM.loading && (!TM.loaded || TM.error)) load(false);
  };
  if (typeof activeView !== 'undefined' && activeView === 'tasks') window.renderTasksView();
})();
