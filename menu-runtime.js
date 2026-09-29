(() => {
  const sectionMap = { kebab: 'kebab', stews: 'stews', rice: 'rice', side: 'side', starters: 'starters', wraps: 'wraps', desserts: 'desserts', drinks: 'drinks', sauces: 'sauces' };

  function makeItem(item) {
    const card = document.createElement('div');
    card.className = 'menu-item';
    card.dataset.menuId = item.id;
    const row = document.createElement('div');
    row.className = 'menu-item-row';
    const titleWrap = document.createElement('div');
    titleWrap.className = 'menu-item-title-wrap';
    if (item.image) {
      const image = document.createElement('img');
      image.className = 'menu-item-image'; image.src = item.image; image.alt = ''; image.loading = 'lazy';
      titleWrap.appendChild(image);
    }
    const title = document.createElement('strong');
    const name = document.createElement('span');
    name.className = 'item-en'; name.textContent = item.name;
    title.appendChild(name); titleWrap.appendChild(title); row.appendChild(titleWrap); card.appendChild(row);
    const price = document.createElement('span');
    price.className = 'price'; price.append(`${(item.price_cents / 100).toFixed(2).replace('.', ',')} EUR `);
    const button = document.createElement('button');
    button.className = 'order-btn'; button.type = 'button'; button.textContent = '+';
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

  async function loadDatabaseMenu() {
    const response = await fetch('/api/menu');
    if (!response.ok) throw new Error('Menu API unavailable');
    const data = await response.json();
    renderMenu(data.items);
    const deliveryResponse = await fetch('/api/settings/delivery');
    if (deliveryResponse.ok && !(await deliveryResponse.json()).open) {
      const notice = document.createElement('div');
      notice.className = 'delivery-closed-notice';
      notice.textContent = 'Delivery is currently closed. Takeaway and restaurant dining are still available.';
      document.querySelector('.center-panel')?.prepend(notice);
    }
  }

  loadDatabaseMenu().catch(() => {});
})();
