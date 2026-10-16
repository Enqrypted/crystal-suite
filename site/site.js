// Crystal Suite website: the wavy ribbons behind the hero and the download band, and the apps menu.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  // In the dark theme the same palette is mixed toward the page background (--wave-mix), so one set of
  // colours per page serves both themes.
  const rgb = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim()); const n = m ? parseInt(m[1], 16) : 0; return [n >> 16, (n >> 8) & 255, n & 255]; };
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return `rgb(${x.map((c, i) => Math.round(c + (y[i] - c) * t)).join(',')})`; };
  function palette() {
    const cs = getComputedStyle(document.body);
    const v = (n) => cs.getPropertyValue(n).trim();
    const t = parseFloat(v('--wave-mix')) || 0, bg = v('--bg') || '#000000';
    const c = (n) => (t ? mix(v(n), bg, t) : v(n));
    return {
      alpha: parseFloat(v('--wave-alpha')) || 0.6,
      bands: [[c('--w1a'), c('--w1b')], [c('--w2a'), c('--w2b')], [c('--w3a'), c('--w3b')], [c('--w4a'), c('--w4b')]],
    };
  }

  // Each band is a sum of slow sines; `top` and `amp` are fractions of the canvas height.
  const BANDS = [
    { top: 0.58, amp: 0.07, k1: 1.6, k2: 3.7, s1: 0.11, s2: -0.07, ph: 0.4 },
    { top: 0.67, amp: 0.06, k1: 2.1, k2: 4.4, s1: -0.09, s2: 0.06, ph: 2.1 },
    { top: 0.76, amp: 0.055, k1: 1.3, k2: 3.1, s1: 0.08, s2: 0.1, ph: 4.0 },
    { top: 0.86, amp: 0.045, k1: 1.9, k2: 5.2, s1: -0.06, s2: -0.08, ph: 5.3 },
  ];

  function ribbons(canvas) {
    const ctx = canvas.getContext('2d');
    let w = 0, h = 0, pal = palette(), raf = 0, visible = true, t0 = performance.now();
    // shift the ribbons down for short heroes, so they stay under the text
    const shape = { band: -0.02, low: -0.1 }[canvas.dataset.shape] ?? 0;

    const size = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(2, devicePixelRatio || 1);
      w = Math.max(1, Math.round(r.width)); h = Math.max(1, Math.round(r.height));
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const draw = (now) => {
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, w, h);
      BANDS.forEach((b, i) => {
        const [ca, cb] = pal.bands[i];
        const top = (b.top - shape) * h;
        const amp = b.amp * h;
        const g = ctx.createLinearGradient(0, top - amp, w, top + amp * 3);
        g.addColorStop(0, ca); g.addColorStop(1, cb);
        ctx.globalAlpha = pal.alpha;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(0, h);
        const step = Math.max(6, w / 160);
        for (let x = 0; x <= w + step; x += step) {
          const u = x / w;
          const y = top
            + Math.sin(u * Math.PI * b.k1 + b.ph + t * b.s1 * 2) * amp
            + Math.sin(u * Math.PI * b.k2 + b.ph * 1.7 + t * b.s2 * 2) * amp * 0.35;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fill();
        // a soft highlight along the crest
        ctx.globalAlpha = pal.alpha * 0.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1;
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    };
    const loop = (now) => { draw(now); raf = visible && !reduce.matches && !document.hidden ? requestAnimationFrame(loop) : 0; };
    const start = () => { if (!raf) raf = requestAnimationFrame(loop); };

    size();
    draw(performance.now());
    new ResizeObserver(() => { size(); draw(performance.now()); }).observe(canvas);
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) start(); }).observe(canvas);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });
    reduce.addEventListener?.('change', () => { draw(performance.now()); start(); });
    const repaint = () => { pal = palette(); draw(performance.now()); };
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', repaint);
    new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    start();
  }

  document.querySelectorAll('canvas.waves').forEach(ribbons);

  // the Apps menu closes on an outside click or Escape
  const menu = document.querySelector('.apps-menu');
  if (menu) {
    document.addEventListener('click', (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); } });
  }
})();
