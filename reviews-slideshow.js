(() => {
  document.querySelectorAll('[data-review-carousel]').forEach(carousel => {
    const slides = [...carousel.querySelectorAll('.review-slide')];
    const count = carousel.querySelector('.review-slide-count');
    const previous = carousel.querySelector('.review-slide-prev');
    const next = carousel.querySelector('.review-slide-next');
    if (!slides.length) return;
    carousel.classList.add('is-running');

    if (carousel.closest('.home-reviews')) {
      slides.forEach(slide => {
        const reviewText = slide.querySelector('.review-text');
        if (!reviewText || slide.querySelector('.review-read-more')) return;
        const button = document.createElement('button');
        button.className = 'review-read-more';
        button.type = 'button';
        button.textContent = 'Read more';
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', () => {
          const expanded = button.getAttribute('aria-expanded') !== 'true';
          button.setAttribute('aria-expanded', String(expanded));
          button.textContent = expanded ? 'Show less' : 'Read more';
          reviewText.classList.toggle('is-expanded', expanded);
          slide.classList.toggle('is-expanded-review', expanded);
          carousel.classList.toggle('review-expanded', expanded);
          carousel.closest('.home-reviews')?.classList.toggle('has-expanded-review', expanded);
        });
        slide.appendChild(button);
      });
    }

    slides.forEach(slide => {
      const image = slide.querySelector('img');
      if (!image) return;
      image.addEventListener('error', () => {
        if (image.classList.contains('reviewer-avatar')) {
          const name = slide.querySelector('.reviewer strong')?.textContent || '?';
          const initials = name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
          const fallback = document.createElement('span');
          fallback.className = 'reviewer-avatar reviewer-initials';
          fallback.setAttribute('aria-hidden', 'true');
          fallback.textContent = initials || '?';
          image.replaceWith(fallback);
          return;
        }
        const filename = image.getAttribute('src').split('/').pop();
        if (image.dataset.rootRetry !== 'done') {
          image.dataset.rootRetry = 'done';
          image.src = `/Google-reviews/${encodeURIComponent(filename)}`;
        } else {
          slide.classList.add('review-image-unavailable');
        }
      });
    });

    let current = 0;
    let timer = null;
    let paused = false;
    const FADE_MS = 900;
    const landingReviews = Boolean(carousel.closest('.home-reviews, .about-reviews'));
    const ROTATION_MS = landingReviews ? 10000 : 5000;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    slides.forEach((slide, index) => {
      slide.hidden = index !== 0;
      slide.classList.toggle('is-active', index === 0);
    });

    const show = index => {
      const nextIndex = (index + slides.length) % slides.length;
      if (nextIndex === current) return;

      slides.forEach(slide => {
        slide.classList.remove('is-expanded-review');
        slide.querySelector('.review-text')?.classList.remove('is-expanded');
        const readMore = slide.querySelector('.review-read-more');
        if (readMore) {
          readMore.setAttribute('aria-expanded', 'false');
          readMore.textContent = 'Read more';
        }
      });
      carousel.classList.remove('review-expanded');
      carousel.closest('.home-reviews')?.classList.remove('has-expanded-review');

      const outgoingSlide = slides[current];
      const incomingSlide = slides[nextIndex];
      incomingSlide.hidden = false;
      // Make sure the browser paints the incoming card before starting both fades.
      incomingSlide.getBoundingClientRect();
      incomingSlide.classList.add('is-active');
      incomingSlide.classList.remove('is-fading');
      outgoingSlide.classList.remove('is-active');
      outgoingSlide.classList.add('is-fading');
      window.setTimeout(() => {
        if (!outgoingSlide.classList.contains('is-active')) {
          outgoingSlide.hidden = true;
          outgoingSlide.classList.remove('is-fading');
        }
      }, FADE_MS);

      current = nextIndex;
      if (count) count.textContent = `${current + 1} / ${slides.length}`;
    };
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      if (paused || document.hidden || reduceMotion.matches || slides.length < 2) return;
      timer = window.setInterval(() => show(current + 1), ROTATION_MS);
    };

    previous?.addEventListener('click', () => { show(current - 1); start(); });
    next?.addEventListener('click', () => { show(current + 1); start(); });
    if (!landingReviews) {
      carousel.addEventListener('mouseenter', () => { paused = true; stop(); });
      carousel.addEventListener('mouseleave', () => { paused = false; start(); });
    }
    carousel.addEventListener('focusin', () => { paused = true; stop(); });
    carousel.addEventListener('focusout', event => {
      if (!carousel.contains(event.relatedTarget)) { paused = false; start(); }
    });
    document.addEventListener('visibilitychange', () => document.hidden ? stop() : start());
    reduceMotion.addEventListener?.('change', () => reduceMotion.matches ? stop() : start());

    start();
  });
})();
