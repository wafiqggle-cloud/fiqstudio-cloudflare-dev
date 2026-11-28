/* FiqStudio motion: every button gets a magnetic hover (desktop), a spring press, a ripple and an icon bounce.
   Works for buttons added later (event delegation). Off when the device asks for reduced motion.
   Uses the CSS `translate` / `scale` properties so it composes with any existing `transform` animation (GSAP). */
(function () {
  'use strict';
  if (window.__fqMotion) return;
  window.__fqMotion = true;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const SEL = 'button, a.btn, a.tap-pop, a[role="button"], [role="button"], .nav-btn, .mob-nav-btn, .tabs a, nav a, .hub-link, .hub-tasks-btn, .fiq-sugg, .stat, .card, .pcard';
  const SKIP = '#fiqAiFab, [data-no-motion], input, select, textarea, [disabled], [aria-disabled="true"]';
  const rippleOff = (document.currentScript && document.currentScript.dataset.ripple === 'off');
  const spring = 'cubic-bezier(.34,1.56,.64,1)';

  const css = document.createElement('style');
  css.textContent = `
    .fx-btn{transition:translate .45s ${spring},scale .32s ${spring},transform .26s ${spring},background-color .16s ease,border-color .16s ease,color .16s ease,box-shadow .2s ease,opacity .2s ease}
    .fx-btn.fx-press{scale:.93;transition:translate .2s ease,scale .1s ease,transform .1s ease,background-color .16s ease,border-color .16s ease,color .16s ease,box-shadow .2s ease}
    .fx-btn.fx-pop{animation:fxPop .45s ${spring}}
    .fx-btn > svg,.fx-btn .fx-ico{transition:rotate .45s ${spring},scale .45s ${spring}}
    .fx-btn.fx-hover > svg{scale:1.12;rotate:-6deg}
    .fx-rip{position:absolute;border-radius:9999px;pointer-events:none;background:currentColor;opacity:.22;scale:0;animation:fxRip .6s cubic-bezier(.16,1,.3,1) forwards;z-index:0}
    @keyframes fxRip{to{scale:1;opacity:0}}
    @keyframes fxPop{0%{scale:.92}55%{scale:1.05}100%{scale:1}}
    @media (prefers-reduced-motion: reduce){.fx-btn{translate:none !important;scale:none !important;animation:none !important}.fx-rip{display:none}}`;
  document.head.appendChild(css);

  const target = (el) => {
    const b = el && el.closest ? el.closest(SEL) : null;
    if (!b || b.matches(SKIP) || b.closest('[data-no-motion]')) return null;
    return b;
  };
  const prep = (b) => {
    if (b.classList.contains('fx-btn')) return;
    b.classList.add('fx-btn');
    const cs = getComputedStyle(b);
    if (cs.position === 'static') b.style.position = 'relative';
    if (cs.overflow === 'visible' && !b.matches('.card,.pcard,.stat')) b.style.overflow = 'hidden';
  };

  // Magnetic hover (mouse/pen only).
  document.addEventListener('pointerover', (e) => {
    if (reduce.matches || e.pointerType === 'touch') return;
    const b = target(e.target); if (!b) return;
    prep(b); b.classList.add('fx-hover');
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (reduce.matches || e.pointerType === 'touch') return;
    const b = target(e.target); if (!b || !b.classList.contains('fx-btn')) return;
    const r = b.getBoundingClientRect();
    const big = r.width > 220 || r.height > 120;
    const k = big ? 3 : 6;
    const dx = ((e.clientX - (r.left + r.width / 2)) / (r.width / 2)) * k;
    const dy = ((e.clientY - (r.top + r.height / 2)) / (r.height / 2)) * (k * 0.7) - (big ? 2 : 1.5);
    b.style.translate = `${dx.toFixed(1)}px ${dy.toFixed(1)}px`;
  }, { passive: true });
  document.addEventListener('pointerout', (e) => {
    const b = target(e.target); if (!b) return;
    if (e.relatedTarget && b.contains(e.relatedTarget)) return;
    b.style.translate = ''; b.classList.remove('fx-hover', 'fx-press');
  }, true);

  // Spring press + ripple (touch and mouse).
  document.addEventListener('pointerdown', (e) => {
    if (reduce.matches) return;
    const b = target(e.target); if (!b) return;
    prep(b); b.classList.add('fx-press');
    if (rippleOff || b.matches('.card,.pcard,.stat')) return;
    const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2.2, s = document.createElement('span');
    s.className = 'fx-rip';
    s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
    b.appendChild(s); setTimeout(() => s.remove(), 650);
  }, true);
  const release = (e) => {
    document.querySelectorAll('.fx-btn.fx-press').forEach((b) => {
      b.classList.remove('fx-press');
      if (!reduce.matches) { b.classList.remove('fx-pop'); void b.offsetWidth; b.classList.add('fx-pop'); setTimeout(() => b.classList.remove('fx-pop'), 480); }
      if (e.pointerType === 'touch') b.style.translate = '';
    });
  };
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);

  // Keyboard: a quick pop when activated with Enter / Space.
  document.addEventListener('keydown', (e) => {
    if (reduce.matches || (e.key !== 'Enter' && e.key !== ' ')) return;
    const b = target(document.activeElement); if (!b) return;
    prep(b); b.classList.remove('fx-pop'); void b.offsetWidth; b.classList.add('fx-pop'); setTimeout(() => b.classList.remove('fx-pop'), 480);
  });
})();
