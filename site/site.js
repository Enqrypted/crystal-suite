// Crystal Suite website: sections fade in as they scroll into view, the hero screenshot follows the pointer a
// little, and the Apps menu closes on an outside click or Escape. Everything works without this file.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // reveal on scroll (the hidden state only exists when this script runs: see the "js" class)
  const items = document.querySelectorAll('.reveal, .tilt-up');
  if (reduce || !('IntersectionObserver' in window)) items.forEach((el) => el.classList.add('in'));
  else {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    // stagger siblings that come in together
    items.forEach((el) => {
      const sibs = el.parentElement ? [...el.parentElement.children].filter((c) => c.classList.contains('reveal')) : [];
      const i = sibs.indexOf(el);
      if (i > 0) el.style.transitionDelay = `${Math.min(i, 6) * 70}ms`;
      io.observe(el);
    });
  }

  // the hero screenshot leans toward the pointer
  const hero = document.querySelector('.hero-visual');
  const tilt = hero && hero.querySelector('.tilt');
  if (tilt && !reduce && matchMedia('(pointer: fine) and (min-width: 1020px)').matches) {
    let raf = 0;
    hero.addEventListener('pointermove', (e) => {
      const r = hero.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { tilt.style.transform = `rotateY(${-8 + x * 10}deg) rotateX(${4 - y * 8}deg)`; });
    });
    hero.addEventListener('pointerleave', () => { cancelAnimationFrame(raf); tilt.style.transform = ''; });
  }

  // the Apps menu closes on an outside click or Escape
  const menu = document.querySelector('.apps-menu');
  if (menu) {
    document.addEventListener('click', (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); } });
  }
})();
