(() => {
  const sectionMap = { kebab: 'kebab', stews: 'stews', rice: 'rice', side: 'side', starters: 'starters', wraps: 'wraps', desserts: 'desserts', drinks: 'drinks', sauces: 'sauces' };
  const weekdays = { sunday: 'Sunday', monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday' };

  function makeItem(item) {
    const card = document.createElement('div');
    const available = Boolean(item.available);
    card.className = `menu-item${available ? '' : ' is-unavailable'}`;
    card.dataset.menuId = item.id;
    const row = document.createElement('div');
    row.className = 'menu-item-row';
    const titleWrap = document.createElement('div');
    titleWrap.className = 'menu-item-title-wrap';
    titleWrap.tabIndex = 0;
    titleWrap.setAttribute('role', 'button');
    titleWrap.setAttribute('aria-label', `View details for ${item.name}${available ? '' : ' (sold out)'}`);
    if (item.image) {
      const image = document.createElement('img');
      image.className = 'menu-item-image'; image.src = item.image; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; image.width = 480; image.height = 480;
      titleWrap.appendChild(image);
    }
    const title = document.createElement('strong');
    const name = document.createElement('span');
    name.className = 'item-en'; name.textContent = item.name;
    title.appendChild(name);
    if (item.name_fa) { const persian = document.createElement('span'); persian.className = 'item-fa'; persian.textContent = item.name_fa; title.appendChild(persian); }
    titleWrap.appendChild(title); row.appendChild(titleWrap); card.appendChild(row);
    if (!available) {
      const badge = document.createElement('span');
      badge.className = 'menu-sold-out-badge';
      badge.textContent = 'Sold out';
      card.appendChild(badge);
    }
    let availableDays = [];
    try { availableDays = JSON.parse(item.available_days || '[]'); } catch (error) { console.error('Could not read menu schedule.', error); }
    if (Array.isArray(availableDays) && availableDays.length) {
      const schedule = document.createElement('span');
      schedule.className = 'menu-availability-badge';
      schedule.textContent = `Available ${availableDays.map(day => weekdays[day]).filter(Boolean).join(', ')}`;
      card.appendChild(schedule);
    }
    const price = document.createElement('span');
    price.className = 'price'; price.append(`${(item.price_cents / 100).toFixed(2).replace('.', ',')} EUR `);
    const button = document.createElement('button');
    button.className = 'order-btn'; button.type = 'button'; button.textContent = available ? '+' : 'Sold out'; button.disabled = !available;
    if (!available) button.setAttribute('aria-label', `${item.name} is sold out`);
    price.appendChild(button); card.appendChild(price);
    if (item.description) {
      const description = document.createElement('div');
      description.className = 'menu-desc'; description.textContent = item.description; card.appendChild(description);
    }
    return card;
  }

  function renderMenu(items) {
    Object.values(sectionMap).forEach(id => document.getElementById(id)?.querySelectorAll('.menu-item').forEach(item => item.remove()));
    items.forEach(item => document.getElementById(sectionMap[item.category])?.appendChild(makeItem(item)));
  }

  let lastMenuSignature = '';
  let menuLoadInProgress = false;
  async function loadDatabaseMenu() {
    if (menuLoadInProgress) return;
    menuLoadInProgress = true;
    try {
    const response = await fetch('/api/menu');
    if (!response.ok) throw new Error('Menu API unavailable');
    const data = await response.json();
    window.mamanpazMenuItems = data.items;
    window.mamanpazWrapSaucePriceCents = Number(data.wrapSaucePriceCents) || 50;
    const signature = JSON.stringify(data);
    if (signature !== lastMenuSignature) {
      renderMenu(data.items.filter(item => {
        let availableDays = [];
        try { availableDays = JSON.parse(item.available_days || '[]'); } catch (error) { console.error('Could not read menu schedule.', error); }
        return !Array.isArray(availableDays) || !availableDays.length || availableDays.includes(data.today);
      }));
      lastMenuSignature = signature;
    }
    const [deliveryResponse, hoursResponse, modeResponse] = await Promise.all([
      fetch('/api/settings/delivery'),
      fetch('/api/settings/business-hours'),
      fetch('/api/settings/order-mode')
    ]);
    const testMode = modeResponse.ok && (await modeResponse.json()).testMode;
    document.querySelector('.menu-test-mode-notice')?.remove();
    if (testMode) {
      const notice = document.createElement('div');
      notice.className = 'delivery-closed-notice menu-test-mode-notice';
      notice.textContent = 'TEST MODE: orders will be saved as test records; no order emails or delivery actions will be triggered.';
      document.querySelector('.center-panel')?.prepend(notice);
    }
    document.querySelector('.delivery-closed-notice:not(.menu-test-mode-notice)')?.remove();
    if (deliveryResponse.ok && !(await deliveryResponse.json()).open && !testMode) {
      const notice = document.createElement('div');
      notice.className = 'delivery-closed-notice';
      notice.textContent = 'Delivery is currently closed. Takeaway and restaurant dining are still available.';
      document.querySelector('.center-panel')?.prepend(notice);
    }
    document.querySelector('.ordering-closed-notice')?.remove();
    if (hoursResponse.ok && !(await hoursResponse.json()).openNow && !testMode) {
      const notice = document.createElement('div');
      notice.className = 'delivery-closed-notice ordering-closed-notice';
      notice.textContent = 'Online ordering is currently closed. Please visit us during opening hours or contact the restaurant.';
      document.querySelector('.center-panel')?.prepend(notice);
    }
    } finally { menuLoadInProgress = false; }
  }

  loadDatabaseMenu().catch(error => console.error('Could not load the current menu.', error));
  window.setInterval(() => { if (!document.hidden) loadDatabaseMenu().catch(error => console.error('Could not refresh the current menu.', error)); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadDatabaseMenu().catch(error => console.error('Could not refresh the current menu.', error)); });
})();
