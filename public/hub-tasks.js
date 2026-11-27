/* Hub "Task Management" widget: summary from /api/pm/summary (same D1 as the FiqStudio Tasks app) + motion. */
(function () {
  'use strict';
  const TASKS_URL = 'https://fiqstudio-task.wafiq-ggle.workers.dev/';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let last = 0, busy = false, data = null;

  // Motion for the widget (hover lift, press spring, staggered rows). Respects reduced motion.
  const css = document.createElement('style');
  css.textContent = `
    .hub-tasks{transition:transform .3s cubic-bezier(.34,1.56,.64,1),box-shadow .25s}
    .hub-tasks:hover{transform:translateY(-2px)}
    .hub-tasks-icon{transition:transform .35s cubic-bezier(.34,1.56,.64,1)}
    .hub-tasks:hover .hub-tasks-icon{transform:rotate(-8deg) scale(1.08)}
    .hub-tasks-btn{position:relative;overflow:hidden;transition:transform .26s cubic-bezier(.34,1.56,.64,1),background-color .16s,box-shadow .2s}
    .hub-tasks-btn:hover{transform:translateY(-2px);box-shadow:0 8px 18px -8px #B8431B}
    .hub-tasks-btn:hover svg{transform:translateX(3px)}
    .hub-tasks-btn svg{transition:transform .3s cubic-bezier(.34,1.56,.64,1)}
    .hub-tasks-btn:active{transform:scale(.94);transition-duration:.09s}
    .hub-tasks-stat{transition:transform .26s cubic-bezier(.34,1.56,.64,1)}
    .hub-tasks-stat:hover{transform:translateY(-2px)}
    .hub-tasks-row{animation:hubTaskIn .45s cubic-bezier(.16,1,.3,1) both}
    .hub-tasks-row:nth-child(2){animation-delay:.06s}.hub-tasks-row:nth-child(3){animation-delay:.12s}
    @keyframes hubTaskIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    .hub-rip{position:absolute;border-radius:50%;background:#fff;opacity:.3;transform:scale(0);animation:hubRip .55s cubic-bezier(.16,1,.3,1) forwards;pointer-events:none}
    @keyframes hubRip{to{transform:scale(1);opacity:0}}
    @media (prefers-reduced-motion:reduce){.hub-tasks,.hub-tasks *{animation:none!important;transition:none!important}}`;
  document.head.appendChild(css);

  function stat(label, value, tone) {
    const color = tone === 'bad' && value ? 'text-red-700 dark:text-red-300' : 'text-[#1C1917] dark:text-[#F5EFE6]';
    return `<div class="hub-tasks-stat rounded-xl bg-white/45 dark:bg-zinc-900/55 border border-white/70 dark:border-zinc-800 px-2.5 py-2 min-w-0">
      <p class="text-[10px] font-semibold text-[#57534E] dark:text-[#C7B8AC] truncate">${label}</p>
      <p class="font-display text-lg font-extrabold leading-tight ${color}">${value}</p></div>`;
  }
  function dueLabel(due, today) {
    if (!due) return '';
    if (due < today) return `<span class="text-[11px] font-semibold text-red-700 dark:text-red-300">Overdue</span>`;
    if (due === today) return `<span class="text-[11px] font-semibold text-[#9A3412] dark:text-[#FDBA74]">Today</span>`;
    const d = new Date(due + 'T00:00:00');
    return `<span class="text-[11px] text-[#57534E] dark:text-[#C7B8AC]">${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>`;
  }
  // Open the task app in the same light/dark theme as the Hub.
  function syncLink() {
    const a = document.getElementById('hubTasksOpen');
    if (!a) return;
    const dark = typeof state !== 'undefined' && state ? !!state.darkMode : document.documentElement.classList.contains('dark');
    a.href = TASKS_URL + '?theme=' + (dark ? 'dark' : 'light') + '#dashboard';
  }
  function paint() {
    syncLink();
    const stats = document.getElementById('hubTasksStats');
    const next = document.getElementById('hubTasksNext');
    const sub = document.getElementById('hubTasksSub');
    if (!stats || !next) return;
    if (!data) {
      stats.innerHTML = stat('Open', '–') + stat('Today', '–') + stat('Overdue', '–') + stat('Projects', '–');
      next.innerHTML = '';
      return;
    }
    if (data.error) {
      sub.textContent = data.error;
      stats.innerHTML = ''; next.innerHTML = '';
      return;
    }
    sub.textContent = data.openTasks ? `${data.openTasks} open task${data.openTasks === 1 ? '' : 's'}` : 'All clear. Add tasks in the Task Manager';
    stats.innerHTML = stat('Open', data.openTasks) + stat('Today', data.dueToday) + stat('Overdue', data.overdue, 'bad') + stat('Projects', data.activeProjects);
    next.innerHTML = (data.next || []).map((t) => `
      <li class="hub-tasks-row flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-white/45 dark:bg-zinc-900/55 border border-white/70 dark:border-zinc-800">
        <span class="text-xs font-semibold text-[#1C1917] dark:text-[#F5EFE6] truncate">${esc(t.title)}</span>${dueLabel(t.due, data.today)}
      </li>`).join('');
  }
  async function refresh() {
    if (busy || typeof SERVER_PROXY === 'undefined' || !SERVER_PROXY) return;
    busy = true; last = Date.now();
    try {
      const res = await fetch('/api/pm/summary', { cache: 'no-store' });
      data = res.ok ? await res.json() : { error: res.status === 401 ? 'Sign in again to see tasks' : 'Task summary unavailable' };
    } catch (e) { data = { error: 'Task summary unavailable' }; }
    busy = false; last = Date.now(); paint();
  }

  window.renderHubTasks = function () {
    paint();
    if (Date.now() - last > 60000) refresh();
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { last = 0; if (typeof activeView !== 'undefined' && activeView === 'hub') window.renderHubTasks(); } });
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.hub-tasks-btn');
    if (!b || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2, s = document.createElement('span');
    s.className = 'hub-rip';
    s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
    b.appendChild(s); setTimeout(() => s.remove(), 600);
  });
  // Keep the theme in the link current when the Hub theme toggle is used.
  document.addEventListener('pointerdown', (e) => { if (e.target.closest('#hubTasksOpen')) syncLink(); }, true);
  syncLink();
  if (typeof activeView !== 'undefined' && activeView === 'hub') window.renderHubTasks();
})();
