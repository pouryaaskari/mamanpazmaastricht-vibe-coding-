(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.documentElement;
  const body = document.body;

  if (!body.classList.contains('checkout-page')) {
    const mobileHeader = document.createElement('header');
    mobileHeader.className = 'mobile-site-header';
    mobileHeader.innerHTML = `
      <a class="mobile-site-logo" href="index.html" aria-label="Mamanpaz Maastricht home">
        <img src="icons/logomamanpaz.PNG" alt="">
      </a>
      <div class="mobile-site-title">
        <span class="mobile-site-name">Mamanpaz Maastricht</span>
        <span class="mobile-site-subtitle">Authentic Iranian Restaurant</span>
      </div>
      <button class="mobile-nav-toggle" type="button" aria-expanded="false" aria-controls="mobile-site-nav" aria-label="Open navigation menu">
        <span class="mobile-nav-icon" aria-hidden="true"><span></span><span></span><span></span></span>
      </button>
      <nav class="mobile-site-nav" id="mobile-site-nav" aria-label="Main navigation" hidden>
        <a href="index.html" data-page="home-page"><img src="icons/home.png" alt=""><span>Home</span></a>
        <a href="menu.html" data-page="menu-list-page"><img src="icons/menu.png" alt=""><span>Menu</span></a>
        <a href="event.html" data-page="events-page"><img src="icons/events.png" alt=""><span>Events &amp; Arrangements</span></a>
        <a href="contactus.html" data-page="contact-page"><img src="icons/contactus.png" alt=""><span>Contact Us</span></a>
        <a href="aboutus.html" data-page="about-page"><img src="icons/aboutus.png" alt=""><span>About Us</span></a>
      </nav>
    `;
    body.prepend(mobileHeader);

    const currentPage = [...body.classList].find(className =>
      ['home-page', 'menu-list-page', 'events-page', 'contact-page', 'about-page'].includes(className)
    );
    if (currentPage) {
      mobileHeader.querySelector(`[data-page="${currentPage}"]`)?.setAttribute('aria-current', 'page');
    }

    const menuToggle = mobileHeader.querySelector('.mobile-nav-toggle');
    const mobileNav = mobileHeader.querySelector('.mobile-site-nav');
    let closeMenuTimer;
    const setMenuOpen = open => {
      window.clearTimeout(closeMenuTimer);
      menuToggle.setAttribute('aria-expanded', String(open));
      menuToggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
      if (open) {
        mobileNav.hidden = false;
        requestAnimationFrame(() => mobileNav.classList.add('is-open'));
        return;
      }
      mobileNav.classList.remove('is-open');
      closeMenuTimer = window.setTimeout(() => { mobileNav.hidden = true; }, 180);
    };
    menuToggle.addEventListener('click', () => setMenuOpen(menuToggle.getAttribute('aria-expanded') !== 'true'));
    mobileNav.addEventListener('click', event => {
      if (event.target.closest('a')) setMenuOpen(false);
    });
    document.addEventListener('pointerdown', event => {
      if (!mobileHeader.contains(event.target) && menuToggle.getAttribute('aria-expanded') === 'true') setMenuOpen(false);
    });
    document.addEventListener('focusin', event => {
      if (!mobileHeader.contains(event.target) && menuToggle.getAttribute('aria-expanded') === 'true') setMenuOpen(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && menuToggle.getAttribute('aria-expanded') === 'true') {
        setMenuOpen(false);
        menuToggle.focus();
      }
    });
  }

  root.classList.add('site-motion');

  const revealTargets = document.querySelectorAll(
    '.header, .left-div, .main-page, .home-reviews, .home-about, .center-panel, .events-content, .contact-content, .about-content, .checkout-card'
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
