/* Hub "Waktu Solat" widget: JAKIM prayer times for a chosen zone (default Kota Bharu, KTN01),
   countdown to the next prayer, and azan (uploaded audio or a soft chime) + notification while the Hub is open. */
(function () {
  'use strict';
  const LS_ZONE = 'fq_prayer_zone', LS_AZAN = 'fq_prayer_azan';
  const NAMES = { imsak: 'Imsak', fajr: 'Subuh', syuruk: 'Syuruk', dhuhr: 'Zohor', asr: 'Asar', maghrib: 'Maghrib', isha: 'Isyak' };
  const SHOW = ['fajr', 'syuruk', 'dhuhr', 'asr', 'maghrib', 'isha'];
  const AZAN_FOR = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const hhmm = (sec) => new Date(sec * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kuala_Lumpur' });
  const klDate = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);

  let zone = read(LS_ZONE, { code: 'KTN01', label: 'Kota Bharu' });
  let azanOn = !!read(LS_AZAN, false);
  let data = null, loading = false, failed = '', zones = null, hasAudio = null, player = null, tick = null;
  const fired = new Set();

  const css = document.createElement('style');
  css.textContent = `
    .hub-prayer{transition:transform .3s cubic-bezier(.34,1.56,.64,1)}
    .hub-prayer:hover{transform:translateY(-2px)}
    .hp-icon{transition:transform .35s cubic-bezier(.34,1.56,.64,1)}
    .hub-prayer:hover .hp-icon{transform:rotate(-10deg) scale(1.08)}
    .hp-time{transition:transform .26s cubic-bezier(.34,1.56,.64,1),background-color .2s}
    .hp-time:hover{transform:translateY(-2px)}
    .hp-time.is-next{background:#B8431B!important;border-color:#B8431B!important;color:#fff}
    .hp-time.is-next p{color:#fff!important}
    .hp-time.is-past{opacity:.55}
    .hp-ring{animation:hpRing 1.2s ease-in-out infinite}
    @keyframes hpRing{0%,100%{transform:rotate(0)}20%{transform:rotate(-14deg)}40%{transform:rotate(12deg)}60%{transform:rotate(-6deg)}}
    .hp-in{animation:hpIn .35s cubic-bezier(.34,1.56,.64,1) both}
    @keyframes hpIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    @media (prefers-reduced-motion:reduce){.hub-prayer,.hp-time,.hp-icon{transition:none}.hp-ring,.hp-in{animation:none}.hub-prayer:hover,.hp-time:hover{transform:none}}
  `;
  document.head.appendChild(css);

  function mount() {
    if (document.getElementById('hubPrayerCard')) return true;
    const after = document.getElementById('hubTasksCard') || document.getElementById('hubDevicesBar');
    if (!after) return false;
    const el = document.createElement('section');
    el.id = 'hubPrayerCard';
    el.className = 'hub-prayer w-full glass-surface rounded-2xl px-4 py-3.5 flex flex-col gap-3';
    el.setAttribute('aria-labelledby', 'hubPrayerTitle');
    el.innerHTML = `
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="hp-icon w-9 h-9 rounded-xl bg-[#B8431B] text-white flex items-center justify-center shrink-0" aria-hidden="true">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>
          </span>
          <div class="min-w-0">
            <h2 id="hubPrayerTitle" class="font-display text-sm font-bold text-[#1C1917] dark:text-[#F5EFE6] truncate">Waktu Solat</h2>
            <p id="hubPrayerSub" class="text-[11px] text-[#57534E] dark:text-[#C7B8AC] truncate"></p>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button type="button" id="hubPrayerAzan" class="min-h-[36px] px-3 rounded-full text-[11px] font-semibold border inline-flex items-center gap-1.5 cursor-pointer"></button>
          <button type="button" id="hubPrayerLoc" class="min-h-[36px] px-3 rounded-full text-[11px] font-semibold bg-white/60 dark:bg-zinc-800 border border-white/80 dark:border-zinc-700 text-[#57534E] dark:text-[#D6C9BE] cursor-pointer" aria-expanded="false" aria-controls="hubPrayerPanel">Location</button>
        </div>
      </div>
      <div id="hubPrayerAlert" hidden></div>
      <div id="hubPrayerNext" class="flex items-baseline justify-between gap-2 px-1"></div>
      <div id="hubPrayerTimes" class="grid grid-cols-3 sm:grid-cols-6 gap-2"></div>
      <div id="hubPrayerPanel" class="hp-in rounded-xl bg-white/45 dark:bg-zinc-900/55 border border-white/70 dark:border-zinc-800 p-3 space-y-3" hidden>
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" id="hubPrayerGps" class="min-h-[36px] px-3.5 rounded-full bg-[#B8431B] hover:bg-[#9A3412] text-white text-xs font-semibold cursor-pointer">Use my location</button>
          <label class="flex-1 min-w-[200px] text-[11px] font-semibold text-[#57534E] dark:text-[#C7B8AC]">Or choose a zone
            <select id="hubPrayerZone" class="mt-1 w-full px-2.5 py-2 rounded-xl text-xs bg-white/80 dark:bg-zinc-800 border border-white/80 dark:border-zinc-700 text-[#1C1917] dark:text-[#F5EFE6]"><option>Loading zones…</option></select>
          </label>
        </div>
        <div class="border-t border-black/5 dark:border-white/10 pt-3 space-y-2">
          <p class="text-[11px] font-semibold text-[#57534E] dark:text-[#C7B8AC]">Azan sound</p>
          <p id="hubPrayerAudioState" class="text-[11px] text-[#57534E] dark:text-[#C7B8AC]"></p>
          <div class="flex flex-wrap gap-2">
            <label class="min-h-[36px] px-3.5 rounded-full bg-white/70 dark:bg-zinc-800 border border-white/80 dark:border-zinc-700 text-xs font-semibold text-[#1C1917] dark:text-[#F5EFE6] inline-flex items-center cursor-pointer">Upload azan (MP3)<input id="hubPrayerFile" type="file" accept="audio/*" class="sr-only"></label>
            <button type="button" id="hubPrayerTest" class="min-h-[36px] px-3.5 rounded-full bg-white/70 dark:bg-zinc-800 border border-white/80 dark:border-zinc-700 text-xs font-semibold text-[#1C1917] dark:text-[#F5EFE6] cursor-pointer">Test sound</button>
            <button type="button" id="hubPrayerRemove" class="min-h-[36px] px-3.5 rounded-full text-xs font-semibold text-red-700 dark:text-red-300 cursor-pointer" hidden>Remove file</button>
          </div>
          <p class="text-[10px] text-[#57534E] dark:text-[#A8A29E]">Azan plays while FiqStudio Hub is open in a tab. Times from JAKIM.</p>
        </div>
      </div>`;
    after.insertAdjacentElement('afterend', el);
    wire();
    return true;
  }

  function wire() {
    const $ = (id) => document.getElementById(id);
    $('hubPrayerLoc').addEventListener('click', () => {
      const p = $('hubPrayerPanel'); p.hidden = !p.hidden;
      $('hubPrayerLoc').setAttribute('aria-expanded', String(!p.hidden));
      if (!p.hidden) { loadZones(); checkAudio(); }
    });
    $('hubPrayerAzan').addEventListener('click', toggleAzan);
    $('hubPrayerGps').addEventListener('click', useGps);
    $('hubPrayerZone').addEventListener('change', (e) => {
      const z = (zones || []).find((x) => x.code === e.target.value);
      if (z) setZone(z.code, shortArea(z.area));
    });
    $('hubPrayerFile').addEventListener('change', upload);
    $('hubPrayerTest').addEventListener('click', () => playAzan('Test'));
    $('hubPrayerRemove').addEventListener('click', removeAudio);
  }

  const shortArea = (a) => String(a || '').split(',')[0].trim() || a;
  const toast = (m) => { if (typeof window.showToast === 'function') window.showToast(m); else { const s = document.getElementById('hubPrayerSub'); if (s) s.textContent = m; } };

  function setZone(code, label) {
    zone = { code, label }; write(LS_ZONE, zone);
    data = null; fired.clear(); refresh();
  }

  async function loadZones() {
    const sel = document.getElementById('hubPrayerZone');
    if (!zones) {
      try { const r = await fetch('/api/prayer/zones'); const j = await r.json(); if (!r.ok) throw new Error(j.error); zones = j.data; }
      catch (e) { sel.innerHTML = '<option>Zones not available</option>'; return; }
    }
    const byState = {};
    zones.forEach((z) => { (byState[z.state] = byState[z.state] || []).push(z); });
    sel.innerHTML = Object.keys(byState).map((st) => `<optgroup label="${esc(st)}">${byState[st].map((z) => `<option value="${esc(z.code)}" ${z.code === zone.code ? 'selected' : ''}>${esc(z.code)} · ${esc(z.area)}</option>`).join('')}</optgroup>`).join('');
  }

  function useGps() {
    const btn = document.getElementById('hubPrayerGps');
    if (!navigator.geolocation) return toast('This browser cannot share location');
    btn.disabled = true; btn.textContent = 'Finding you…';
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const r = await fetch(`/api/prayer/locate?lat=${pos.coords.latitude.toFixed(4)}&lon=${pos.coords.longitude.toFixed(4)}`);
        const j = await r.json(); if (!r.ok) throw new Error(j.error);
        setZone(j.zone, j.area || j.zone); toast('Location set: ' + (j.area || j.zone));
        const sel = document.getElementById('hubPrayerZone'); if (sel) sel.value = j.zone;
      } catch (e) { toast(e.message || 'Could not find your zone'); }
      btn.disabled = false; btn.textContent = 'Use my location';
    }, () => { toast('Location permission was not given'); btn.disabled = false; btn.textContent = 'Use my location'; }, { timeout: 10000, maximumAge: 3600e3 });
  }

  async function checkAudio() {
    try { hasAudio = (await fetch('/api/prayer/azan', { method: 'HEAD' })).ok; } catch { hasAudio = false; }
    const s = document.getElementById('hubPrayerAudioState'), rm = document.getElementById('hubPrayerRemove');
    if (s) s.textContent = hasAudio ? 'Your azan file is saved. It plays at Subuh, Zohor, Asar, Maghrib and Isyak.' : 'No file yet, so a soft chime plays. Upload your own azan MP3 to use it.';
    if (rm) rm.hidden = !hasAudio;
  }

  async function upload(e) {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast('The file is too big (10 MB max)');
    const s = document.getElementById('hubPrayerAudioState'); if (s) s.textContent = 'Uploading…';
    try {
      const r = await fetch('/api/prayer/azan', { method: 'PUT', headers: { 'content-type': file.type || 'audio/mpeg' }, body: file });
      const j = await r.json(); if (!r.ok) throw new Error(j.error);
      player = null; toast('Azan file saved');
    } catch (err) { toast(err.message || 'Upload failed'); }
    checkAudio();
  }

  async function removeAudio() {
    try { await fetch('/api/prayer/azan', { method: 'DELETE' }); player = null; toast('Azan file removed'); } catch {}
    checkAudio();
  }

  function chime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + i * 0.45;
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.18, t + 0.05); g.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
        o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 1.7);
      });
      setTimeout(() => ctx.close(), 4000);
    } catch {}
  }

  async function playAzan(name) {
    showAlert(name);
    if (hasAudio === null) await checkAudio();
    if (hasAudio) {
      try {
        if (!player) player = new Audio('/api/prayer/azan');
        player.currentTime = 0; await player.play(); return;
      } catch { /* browser blocked autoplay or file failed: fall back to chime */ }
    }
    chime();
  }

  function stopAzan() { if (player) { player.pause(); player.currentTime = 0; } hideAlert(); }

  function showAlert(name) {
    const a = document.getElementById('hubPrayerAlert'); if (!a) return;
    a.className = 'hp-in flex items-center justify-between gap-3 rounded-xl bg-[#B8431B] text-white px-3.5 py-2.5';
    a.innerHTML = `<span class="text-xs font-semibold flex items-center gap-2"><span class="hp-ring inline-block" aria-hidden="true">🔔</span>${name === 'Test' ? 'Testing azan sound' : 'Masuk waktu ' + esc(name) + ' (' + esc(zone.label) + ')'}</span><button type="button" class="min-h-[32px] px-3 rounded-full bg-white/20 hover:bg-white/30 text-xs font-semibold cursor-pointer">Stop</button>`;
    a.hidden = false;
    a.querySelector('button').addEventListener('click', stopAzan);
    clearTimeout(showAlert.t); showAlert.t = setTimeout(hideAlert, 5 * 60e3);
  }
  function hideAlert() { const a = document.getElementById('hubPrayerAlert'); if (a) a.hidden = true; }

  async function toggleAzan() {
    azanOn = !azanOn; write(LS_AZAN, azanOn);
    if (azanOn) {
      if ('Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch {} }
      checkAudio();
      // This click lets the browser play sound later without another tap.
      try { const c = new (window.AudioContext || window.webkitAudioContext)(); c.resume().then(() => c.close()); } catch {}
      toast('Azan on');
    } else { stopAzan(); toast('Azan off'); }
    paintAzanBtn();
  }

  function paintAzanBtn() {
    const b = document.getElementById('hubPrayerAzan'); if (!b) return;
    b.setAttribute('aria-pressed', String(azanOn));
    b.className = 'min-h-[36px] px-3 rounded-full text-[11px] font-semibold border inline-flex items-center gap-1.5 cursor-pointer ' +
      (azanOn ? 'bg-[#B8431B] border-[#B8431B] text-white' : 'bg-white/60 dark:bg-zinc-800 border-white/80 dark:border-zinc-700 text-[#57534E] dark:text-[#D6C9BE]');
    b.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0a3 3 0 11-6 0"/>${azanOn ? '' : '<path stroke-linecap="round" d="M3 3l18 18"/>'}</svg>Azan ${azanOn ? 'on' : 'off'}`;
  }

  function nextPrayer(nowSec) {
    if (!data) return null;
    for (const d of data.days) for (const k of SHOW) { const t = d.times[k]; if (t && t > nowSec) return { key: k, t, date: d.date }; }
    return null;
  }

  function fmtLeft(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}j ${String(m).padStart(2, '0')}m` : `${m}m ${String(sec).padStart(2, '0')}s`;
  }

  function paint() {
    if (!mount()) return;
    paintAzanBtn();
    const sub = document.getElementById('hubPrayerSub'), next = document.getElementById('hubPrayerNext'), grid = document.getElementById('hubPrayerTimes');
    const today = data && data.days.find((d) => d.date === klDate(Date.now()));
    sub.textContent = zone.label + ' · ' + zone.code + (today && today.hijri ? ' · ' + hijriLabel(today.hijri) : '');
    if (!data) {
      next.innerHTML = `<span class="text-xs text-[#57534E] dark:text-[#C7B8AC]">${failed ? esc(failed) : 'Loading prayer times…'}</span>`;
      grid.innerHTML = ''; return;
    }
    const nowSec = Math.floor(Date.now() / 1000), n = nextPrayer(nowSec);
    next.innerHTML = n ? `<span class="text-xs text-[#57534E] dark:text-[#C7B8AC]">Next: <b class="text-[#1C1917] dark:text-[#F5EFE6]">${NAMES[n.key]}</b> at ${hhmm(n.t)}</span><span class="font-display text-lg font-bold tabular-nums text-[#B8431B] dark:text-[#FDBA74]">${fmtLeft(n.t - nowSec)}</span>` : '';
    const d = today || data.days[0];
    grid.innerHTML = SHOW.map((k) => {
      const t = d.times[k], cls = n && n.date === d.date && n.key === k ? 'is-next' : (t && t <= nowSec ? 'is-past' : '');
      return `<div class="hp-time ${cls} rounded-xl bg-white/45 dark:bg-zinc-900/55 border border-white/70 dark:border-zinc-800 px-2.5 py-2 text-center min-w-0">
        <p class="text-[10px] font-semibold text-[#57534E] dark:text-[#C7B8AC] truncate">${NAMES[k]}</p>
        <p class="font-display text-sm font-bold tabular-nums text-[#1C1917] dark:text-[#F5EFE6]">${t ? hhmm(t) : '–'}</p></div>`;
    }).join('');
  }

  function hijriLabel(h) {
    const m = ['Muharram', 'Safar', 'Rabiulawal', 'Rabiulakhir', 'Jamadilawal', 'Jamadilakhir', 'Rejab', 'Syaaban', 'Ramadan', 'Syawal', 'Zulkaedah', 'Zulhijjah'];
    const [y, mo, d] = String(h).split('-').map(Number);
    return y && mo ? `${d} ${m[mo - 1]} ${y}H` : h;
  }

  function checkAzan() {
    if (!data) return;
    const nowSec = Math.floor(Date.now() / 1000);
    for (const d of data.days) for (const k of AZAN_FOR) {
      const t = d.times[k], id = d.date + k;
      if (!t || fired.has(id)) continue;
      if (nowSec >= t && nowSec - t < 90) {
        fired.add(id);
        if (!azanOn) continue;
        playAzan(NAMES[k]);
        if ('Notification' in window && Notification.permission === 'granted') {
          try { new Notification('Masuk waktu ' + NAMES[k], { body: zone.label + ' · ' + hhmm(t), tag: 'fq-prayer-' + id }); } catch {}
        }
      } else if (nowSec - t >= 90) fired.add(id);
    }
  }

  async function refresh() {
    if (loading) return; loading = true; failed = '';
    try {
      const r = await fetch('/api/prayer?zone=' + encodeURIComponent(zone.code));
      const j = await r.json(); if (!r.ok) throw new Error(j.error);
      data = j;
      const nowSec = Math.floor(Date.now() / 1000);
      data.days.forEach((d) => AZAN_FOR.forEach((k) => { if (d.times[k] && nowSec - d.times[k] >= 90) fired.add(d.date + k); }));
    } catch (e) { failed = e.message || 'Prayer times are not available right now'; }
    loading = false; paint();
  }

  function loop() {
    clearInterval(tick);
    tick = setInterval(() => {
      if (data && !data.days.some((d) => d.date === klDate(Date.now()))) { data = null; refresh(); return; }
      if (data && !nextPrayer(Math.floor(Date.now() / 1000))) { refresh(); }
      checkAzan();
      if (!document.hidden) paint();
    }, 1000);
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (!data) refresh(); paint(); } });
  window.renderHubPrayer = paint;
  if (mount()) { paint(); refresh(); loop(); }
  else document.addEventListener('DOMContentLoaded', () => { mount(); paint(); refresh(); loop(); });
})();
