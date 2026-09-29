(() => {
  const state = { menu: [], orders: [], reservations: [], inquiries: [] };
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const response = await fetch(path, { ...options, headers });
    if (response.status === 401) {
      if (path !== '/api/auth/login') {
        showLogin('Your staff session expired. Please log in again.');
        throw new Error('Unauthorized');
      }
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Request failed.');
    }
    return response.status === 204 ? null : response.json();
  }

  function showLogin(message = '') {
    $('adminLogin').hidden = false;
    $('adminDashboard').hidden = true;
    $('loginMessage').textContent = message;
  }

  function showDashboard() {
    $('adminLogin').hidden = true;
    $('adminDashboard').hidden = false;
  }

  function money(cents) {
    return `${(Number(cents) / 100).toFixed(2).replace('.', ',')} EUR`;
  }

  function renderOverview() {
    const today = new Date().toISOString().slice(0, 10);
    $('menuCount').textContent = state.menu.length;
    $('unavailableCount').textContent = state.menu.filter(item => !item.available).length;
    $('newOrderCount').textContent = state.orders.filter(order => order.status === 'new').length;
    $('todayReservationCount').textContent = state.reservations.filter(item => item.reservation_date === today).length;
    $('overviewMessage').textContent = state.orders.length || state.reservations.length ? 'Use the sections above to manage today\'s work.' : 'No orders or reservations are waiting for attention.';
  }

  function renderMenu() {
    $('menuList').innerHTML = state.menu.length ? `<table class="admin-table"><thead><tr><th>Name</th><th>Category</th><th>Price</th><th>Status</th><th>Actions</th></tr></thead><tbody>${state.menu.map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.category)}</td><td>${money(item.price_cents)}</td><td><span class="admin-status ${item.available ? 'is-open' : 'is-closed'}">${item.available ? 'Available' : 'Unavailable'}</span></td><td><button type="button" data-edit-menu="${item.id}">Edit</button> <button type="button" data-delete-menu="${item.id}">Delete</button></td></tr>`).join('')}</tbody></table>` : '<p class="admin-empty">No menu items found. Add the first item above.</p>';
    document.querySelectorAll('[data-edit-menu]').forEach(button => button.addEventListener('click', () => openMenuForm(state.menu.find(item => item.id === Number(button.dataset.editMenu)))));
    document.querySelectorAll('[data-delete-menu]').forEach(button => button.addEventListener('click', async () => {
      if (!window.confirm('Delete this menu item? This cannot be undone.')) return;
      await api(`/api/admin/menu/${button.dataset.deleteMenu}`, { method: 'DELETE' });
      await loadAll();
    }));
  }

  function renderOrders() {
    $('ordersList').innerHTML = state.orders.length ? state.orders.map(order => {
      let items = [];
      try { items = JSON.parse(order.items_json); } catch (_) { /* legacy record */ }
      const itemSummary = Array.isArray(items) ? items.map(item => `${Number(item.quantity) || 0}× ${escapeHtml(item.name)}`).join(', ') : '';
      return `<article class="admin-record"><div><strong>#${order.id} · ${escapeHtml(order.customer_name)}</strong><p>${escapeHtml(order.type)} · ${escapeHtml(order.phone)} · ${money(order.total_cents)}</p><p>${escapeHtml(order.order_time || 'asap')} · ${escapeHtml(order.payment_method || 'cash')} · ${escapeHtml(order.address || 'Pickup order')}</p><p>${itemSummary || 'Order items unavailable'}${order.notes ? ` · Note: ${escapeHtml(order.notes)}` : ''}</p></div><select data-order-status="${order.id}"><option ${order.status === 'new' ? 'selected' : ''}>new</option><option ${order.status === 'accepted' ? 'selected' : ''}>accepted</option><option ${order.status === 'preparing' ? 'selected' : ''}>preparing</option><option ${order.status === 'ready' ? 'selected' : ''}>ready</option><option ${order.status === 'completed' ? 'selected' : ''}>completed</option><option ${order.status === 'cancelled' ? 'selected' : ''}>cancelled</option></select></article>`;
    }).join('') : '<p class="admin-empty">No orders yet.</p>';
    document.querySelectorAll('[data-order-status]').forEach(select => select.addEventListener('change', async () => { await api(`/api/admin/orders/${select.dataset.orderStatus}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) }); await loadAll(); }));
  }

  function renderReservations() {
    $('reservationsList').innerHTML = state.reservations.length ? state.reservations.map(item => `<article class="admin-record"><div><strong>${escapeHtml(item.reservation_date)} · ${escapeHtml(item.reservation_time)} · ${escapeHtml(item.name)}</strong><p>${item.guests} guests · ${escapeHtml(item.phone)} · ${escapeHtml(item.email)}</p><p>${escapeHtml(item.purpose || 'No purpose provided')}${item.notes ? ` · ${escapeHtml(item.notes)}` : ''}</p></div><select data-reservation-status="${item.id}"><option ${item.status === 'pending' ? 'selected' : ''}>pending</option><option ${item.status === 'confirmed' ? 'selected' : ''}>confirmed</option><option ${item.status === 'rejected' ? 'selected' : ''}>rejected</option><option ${item.status === 'cancelled' ? 'selected' : ''}>cancelled</option></select></article>`).join('') : '<p class="admin-empty">No reservations yet.</p>';
    document.querySelectorAll('[data-reservation-status]').forEach(select => select.addEventListener('change', async () => { await api(`/api/admin/reservations/${select.dataset.reservationStatus}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) }); await loadAll(); }));
  }

  function renderInquiries() {
    $('inquiriesList').innerHTML = state.inquiries.length ? state.inquiries.map(item => `<article class="admin-record"><div><strong>${escapeHtml(item.name)} · ${escapeHtml(item.purpose)}</strong><p>${escapeHtml(item.phone)} · ${escapeHtml(item.email)}</p><p>${escapeHtml(item.message || 'No additional details provided')}</p></div></article>`).join('') : '<p class="admin-empty">No event inquiries yet.</p>';
  }

  function openMenuForm(item = null) {
    $('menuForm').hidden = false;
    $('menuFormTitle').textContent = item ? 'Edit menu item' : 'Add menu item';
    $('menuId').value = item?.id || '';
    $('menuName').value = item?.name || '';
    $('menuDescription').value = item?.description || '';
    $('menuPrice').value = item ? item.price_cents / 100 : '';
    $('menuCategory').value = item?.category || '';
    $('menuImage').value = item?.image || '';
    $('menuSortOrder').value = item?.sort_order || 0;
    $('menuAvailable').checked = item ? Boolean(item.available) : true;
  }

  async function loadAll() {
    const [menu, orders, reservations, inquiries, delivery] = await Promise.all([api('/api/admin/menu'), api('/api/admin/orders'), api('/api/admin/reservations'), api('/api/admin/event-inquiries'), api('/api/settings/delivery')]);
    state.menu = menu.items;
    state.orders = orders.orders;
    state.reservations = reservations.reservations;
    state.inquiries = inquiries.inquiries;
    $('deliveryOpen').checked = delivery.open;
    renderOverview(); renderMenu(); renderOrders(); renderReservations(); renderInquiries();
  }

  function setup() {
    $('adminLoginForm').addEventListener('submit', async event => {
      event.preventDefault();
      try {
        const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: $('adminUsername').value, password: $('adminPassword').value }) });
        showDashboard(); await loadAll();
      } catch (error) { $('loginMessage').textContent = error.message; }
    });
    $('logoutAdmin').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); showLogin(); });
    document.querySelectorAll('.admin-tab').forEach(tab => tab.addEventListener('click', () => { document.querySelectorAll('.admin-tab').forEach(item => item.classList.toggle('active', item === tab)); document.querySelectorAll('.admin-panel').forEach(panel => { panel.hidden = panel.id !== tab.dataset.panel; }); }));
    $('newMenuItem').addEventListener('click', () => openMenuForm());
    $('cancelMenu').addEventListener('click', () => { $('menuForm').hidden = true; });
    $('menuForm').addEventListener('submit', async event => {
      event.preventDefault();
      const id = $('menuId').value;
      const payload = { name: $('menuName').value, description: $('menuDescription').value, price: $('menuPrice').value, category: $('menuCategory').value, image: $('menuImage').value, sortOrder: $('menuSortOrder').value, available: $('menuAvailable').checked };
      try { await api(id ? `/api/admin/menu/${id}` : '/api/admin/menu', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) }); $('menuForm').hidden = true; await loadAll(); } catch (error) { $('menuMessage').textContent = error.message; }
    });
    $('saveDelivery').addEventListener('click', async () => { try { await api('/api/admin/settings/delivery', { method: 'PATCH', body: JSON.stringify({ open: $('deliveryOpen').checked }) }); $('deliveryMessage').textContent = 'Delivery status saved.'; } catch (error) { $('deliveryMessage').textContent = error.message; } });

    api('/api/admin/me').then(async () => { showDashboard(); await loadAll(); }).catch(() => showLogin());
  }

  document.addEventListener('DOMContentLoaded', setup);
})();
