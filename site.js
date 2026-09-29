(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.documentElement;
  const body = document.body;

  root.classList.add('site-motion');

  const revealTargets = document.querySelectorAll(
    '.header, .left-div, .main-page, .home-reviews, .center-panel, .events-content, .contact-content, .about-content, .checkout-card'
  );

  revealTargets.forEach((element, index) => {
    element.classList.add('site-reveal');
    if (!reducedMotion) element.style.setProperty('--reveal-delay', `${Math.min(index * 70, 280)}ms`);
  });

  requestAnimationFrame(() => body.classList.add('site-ready'));

  if (reducedMotion) return;

  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const destination = new URL(link.href, window.location.href);
    if (destination.origin !== window.location.origin || destination.pathname === window.location.pathname && destination.hash) return;

    event.preventDefault();
    body.classList.add('site-leaving');
    window.setTimeout(() => {
      window.location.href = destination.href;
    }, 180);
  });

  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    button.classList.remove('button-pressed');
    requestAnimationFrame(() => button.classList.add('button-pressed'));
    window.setTimeout(() => button.classList.remove('button-pressed'), 260);
  });
})();
