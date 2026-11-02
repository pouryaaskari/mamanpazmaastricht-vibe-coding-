(() => {
  const state = { menu: [], orders: [], reservations: [], inquiries: [], notifications: [], testNotifications: [], deliveryPostcodes: [], hours: null, todayWeekday: '', hasLoaded: false, refreshing: false, notificationGranted: false, notificationSupported: false, soundBlockedNoticeShown: false, emailConfigured: false, emailFailureAnnouncements: new Set(), orderDateFilter: '', reservationDateFilter: '', hoursDirty: false };
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
    const today = state.todayDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());
    $('todayOrderCount').textContent = state.orders.filter(order => order.order_date === today).length;
    $('totalOrderCount').textContent = state.orders.length;
    $('newOrderCount').textContent = state.orders.filter(order => order.status === 'new').length;
    $('todayReservationCount').textContent = state.reservations.filter(item => item.reservation_date === today).length;
    renderActivity();
  }

  function activityDate(value) {
    const raw = String(value || '');
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const withZone = /(?:Z|[+-]\d\d:\d\d)$/i.test(normalized) ? normalized : `${normalized}Z`;
    const date = new Date(withZone);
    return Number.isNaN(date.getTime()) ? raw : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function newestFirst(items) {
    return [...items].sort((a, b) => {
      const timestamp = value => {
        const raw = String(value || '');
        const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
        const zoned = /(?:Z|[+-]\d\d:\d\d)$/i.test(normalized) ? normalized : `${normalized}Z`;
        return Date.parse(zoned) || 0;
      };
      const dateA = timestamp(a.created_at);
      const dateB = timestamp(b.created_at);
      return dateB - dateA || Number(b.id) - Number(a.id);
    });
  }

  function renderActivity() {
    const activity = [
      ...state.orders.map(item => ({ type: 'order', panel: 'ordersPanel', createdAt: item.created_at, item })),
      ...state.reservations.map(item => ({ type: 'reservation', panel: 'reservationsPanel', createdAt: item.created_at, item })),
      ...state.inquiries.map(item => ({ type: 'inquiry', panel: 'inquiriesPanel', createdAt: item.created_at, item }))
    ].sort((a, b) => (Date.parse(String(b.createdAt || '').replace(' ', 'T') + 'Z') || 0) - (Date.parse(String(a.createdAt || '').replace(' ', 'T') + 'Z') || 0));
    const visible = activity.slice(0, 30);
    if (!visible.length) {
      $('activityFeed').innerHTML = '<p class="admin-empty">No orders, reservations, or event inquiries yet.</p>';
      return;
    }
    $('activityFeed').innerHTML = visible.map(({ type, panel, createdAt, item }) => {
      let title; let status; let details; let activityKind;
      if (type === 'order') {
        title = `Order #${item.id} · ${item.customer_name}`;
        activityKind = item.type === 'delivery' ? 'Delivery' : 'Pickup';
        status = item.status || 'new';
        details = `${item.type || 'Order'} · ${item.phone || 'No phone'} · ${item.email || 'No email'} · ${money(item.total_cents)}${item.address ? ` · ${item.address}` : ''}${item.notes ? ` · Note: ${item.notes}` : ''}`;
      } else if (type === 'reservation') {
        title = `Reservation #${item.id} · ${item.name}`;
        activityKind = 'Reservation';
        status = item.status || 'pending';
        details = `${item.reservation_date} at ${item.reservation_time} · ${item.guests} guests · ${item.phone} · ${item.email}${item.purpose ? ` · ${item.purpose}` : ''}${item.notes ? ` · Note: ${item.notes}` : ''}`;
      } else {
        title = `Event inquiry #${item.id} · ${item.name}`;
        activityKind = 'Event inquiry';
        status = 'new inquiry';
        details = `${item.purpose} · ${item.phone} · ${item.email}${item.message ? ` · ${item.message}` : ''}`;
      }
      return `<article class="admin-activity-item is-${type}"><div class="admin-activity-marker" aria-hidden="true"></div><div class="admin-activity-content"><div class="admin-activity-title"><strong>${escapeHtml(title)}</strong><span class="admin-activity-kind">${escapeHtml(activityKind)}</span><span class="admin-status-badge">${escapeHtml(status)}</span><button class="admin-secondary" type="button" data-open-panel="${panel}">View ${type}</button></div><p>${escapeHtml(details)}</p><time datetime="${escapeHtml(createdAt || '')}">${escapeHtml(activityDate(createdAt))}</time></div></article>`;
    }).join('');
    $('activityFeed').querySelectorAll('[data-open-panel]').forEach(button => button.addEventListener('click', () => activatePanel(button.dataset.openPanel)));
  }

  function activatePanel(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    document.querySelectorAll('.admin-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.panel === panelId));
    document.querySelectorAll('.admin-panel').forEach(item => { item.hidden = item !== panel; });
  }

  function menuImageDisplayUrl(image) {
    if (!image || !/^menu\/(?!optimized\/)[\w.-]+\.(?:png|jpe?g)$/i.test(image)) return image;
    return image.replace(/^menu\//, 'menu/optimized/').replace(/\.[^.]+$/, '.jpg');
  }

  function renderMenu() {
    const category = $('menuCategoryFilter')?.value || '';
    const query = ($('menuSearch')?.value || '').trim().toLocaleLowerCase();
    const items = state.menu.filter(item => (!category || item.category === category) && (!query || `${item.name} ${item.name_fa || ''} ${item.description || ''}`.toLocaleLowerCase().includes(query)));
    if (!items.length) { $('menuList').innerHTML = state.menu.length ? '<p class="admin-empty">No dishes match this category or search.</p>' : '<p class="admin-empty">No menu items found. Add the first item above.</p>'; return; }
    const rows = items.map(item => {
      let days = [];
      try { days = JSON.parse(item.available_days || '[]'); } catch (_) { days = []; }
      const image = item.image ? `<img class="admin-menu-thumb" src="${escapeHtml(menuImageDisplayUrl(item.image))}" alt="" width="72" height="72" loading="lazy" decoding="async">` : '<span class="admin-menu-no-image">No photo</span>';
      const shownToday = !days.length || days.includes(state.todayWeekday);
      return `<tr><td><div class="admin-menu-item-cell">${image}<span>${escapeHtml(item.name)}${item.name_fa ? `<small dir="rtl" lang="fa">${escapeHtml(item.name_fa)}</small>` : ''}</span></div></td><td>${escapeHtml(item.category)}</td><td>${money(item.price_cents)}</td><td><span class="admin-status ${item.available ? 'is-open' : 'is-closed'}">${item.available ? 'Visible · In stock' : 'Hidden · Sold out'}</span></td><td>${days.length ? days.map(day => escapeHtml(day.slice(0, 3))).join(', ') : 'Every day'}</td><td><span class="admin-status ${shownToday ? 'is-open' : 'is-closed'}">${shownToday ? 'Shown today' : 'Hidden today'}</span></td><td class="admin-menu-actions"><button type="button" data-edit-menu="${item.id}">Edit</button><button type="button" data-toggle-available="${item.id}" data-available="${item.available ? '1' : '0'}">${item.available ? 'Mark sold out' : 'Make visible'}</button><button type="button" data-delete-menu="${item.id}">Delete</button></td></tr>`;
    }).join('');
    $('menuList').innerHTML = `<table class="admin-table"><thead><tr><th>Item</th><th>Category</th><th>Price</th><th>Public menu</th><th>Available days</th><th>Schedule today</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`;
    document.querySelectorAll('[data-edit-menu]').forEach(button => button.addEventListener('click', () => openMenuForm(state.menu.find(item => item.id === Number(button.dataset.editMenu)))));
    document.querySelectorAll('[data-toggle-available]').forEach(button => button.addEventListener('click', async () => {
      const item = state.menu.find(menuItem => menuItem.id === Number(button.dataset.toggleAvailable));
      if (!item) return;
      button.disabled = true;
      try {
        await api(`/api/admin/menu/${item.id}`, { method: 'PATCH', body: JSON.stringify({ available: !item.available }) });
        await loadAll();
      } catch (error) {
        window.alert(error.message);
        button.disabled = false;
      }
    }));
    document.querySelectorAll('[data-delete-menu]').forEach(button => button.addEventListener('click', async () => {
      if (!window.confirm('Delete this menu item? This cannot be undone.')) return;
      try { await api(`/api/admin/menu/${button.dataset.deleteMenu}`, { method: 'DELETE' }); await loadAll(); }
      catch (error) { window.alert(error.message); }
    }));
  }

  function renderOrders() {
    const orders = state.orderDateFilter ? state.orders.filter(order => order.order_date === state.orderDateFilter) : state.orders;
    $('ordersDateFilter').hidden = !state.orderDateFilter;
    $('ordersList').innerHTML = orders.length ? newestFirst(orders).map(order => {
      let items = [];
      try { items = JSON.parse(order.items_json); } catch (_) { /* legacy record */ }
      const itemSummary = Array.isArray(items) ? items.map(item => {
        const sauces = Array.isArray(item.sauces) ? item.sauces.map(sauce => sauce.name) : item.sauce ? [item.sauce.name] : [];
        const extras = [sauces.length ? `Sauces: ${sauces.map(escapeHtml).join(', ')}` : '', item.breadQuantity ? `Extra bread × ${Number(item.breadQuantity)}` : ''].filter(Boolean);
        return `<li><span>${Number(item.quantity) || 0} × ${escapeHtml(item.name)}</span>${extras.length ? `<small>${extras.join(' · ')}</small>` : ''}</li>`;
      }).join('') : '';
      const orderStatusOptions = ['new', 'accepted', 'rejected', 'preparing', 'ready', 'dispatched', 'completed', 'cancelled'];
      const testBadge = order.test_mode ? '<span class="admin-test-badge">TEST ORDER</span>' : '';
      const serviceLabel = order.type === 'delivery'
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h11v11H3zM14 10h4l3 3v4h-7zM7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/></svg><span>Delivery</span>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-1 13H6L5 8Zm3 0a4 4 0 0 1 8 0"/></svg><span>Takeaway</span>';
      const customerType = ['first-time', 'returning'].includes(order.customer_type) ? order.customer_type : 'unknown';
      const customerTypeLabel = customerType === 'first-time' ? 'First-time customer' : customerType === 'returning' ? 'Returning customer' : 'Unknown';
      const customerEmail = order.email ? `<a href="mailto:${escapeHtml(order.email)}">${escapeHtml(order.email)}</a>` : '<span>No email provided</span>';
      return `<article class="admin-record admin-order-record ${order.status === 'new' ? 'is-pending' : ''} ${order.test_mode ? 'is-test-order' : ''}">
        <header class="admin-order-header"><strong>Order #${order.id} ${testBadge}</strong><span class="admin-order-service ${order.type === 'delivery' ? 'is-delivery' : 'is-takeaway'}">${serviceLabel}</span><span class="admin-status-badge">${escapeHtml(order.status || 'new')}</span></header>
        <div class="admin-order-columns">
          <section class="admin-order-section"><h3>Order information</h3><p class="admin-order-datetime">${escapeHtml(order.order_date || '')} · ${escapeHtml(order.order_time || 'asap')} · ${escapeHtml(order.payment_method || 'cash')}</p><ul class="admin-order-items">${itemSummary || '<li>Order items unavailable</li>'}</ul><p class="admin-order-total">Total <strong>${money(order.total_cents)}</strong></p><p><strong>Customer instructions:</strong> ${escapeHtml(order.notes || 'None')}</p>${order.type === 'delivery' ? `<p><strong>Delivery instructions:</strong> ${escapeHtml(order.delivery_instructions || 'None')}</p>` : ''}${order.rejection_reason ? `<p><strong>Rejection reason:</strong> ${escapeHtml(order.rejection_reason)}</p>` : ''}</section>
          <section class="admin-order-section"><h3>Customer information</h3><p><strong>${escapeHtml(order.customer_name)}</strong> <span class="admin-customer-badge is-${customerType}">${customerTypeLabel}</span></p><p><a href="tel:${escapeHtml(order.phone)}">${escapeHtml(order.phone)}</a></p><p>${customerEmail}</p>${order.type === 'delivery' ? `<p><strong>Delivery address:</strong><br>${escapeHtml(order.address || 'Address missing')}</p>` : ''}<p class="admin-order-received">Received ${escapeHtml(order.created_at || '')}</p></section>
        </div><div class="admin-record-actions"><label class="admin-action-label">Status<select data-order-status="${order.id}">${orderStatusOptions.map(status => `<option value="${status}" ${order.status === status ? 'selected' : ''}>${status}</option>`).join('')}</select></label>${order.status === 'new' ? `<button class="admin-accept-order" type="button" data-accept-order="${order.id}">Accept Order</button>` : ''}<button class="admin-danger" type="button" data-delete-order="${order.id}">Remove</button></div></article>`;
    }).join('') : `<p class="admin-empty">${state.orderDateFilter ? 'No orders scheduled for today.' : 'No orders yet.'}</p>`;
    const testPanel = $('testNotificationPanel');
    testPanel.hidden = !state.orders.some(order => order.test_mode);
    $('testNotificationList').innerHTML = state.testNotifications.length ? state.testNotifications.map(item => `<details class="admin-test-notification"><summary>#${item.order_id} · ${escapeHtml(item.subject)} · ${escapeHtml(item.created_at)}</summary><p>Would send to: ${escapeHtml(item.intended_recipient || 'no customer email provided')}</p><pre>${escapeHtml(item.body)}</pre></details>`).join('') : '<p class="admin-empty">No test notifications recorded yet.</p>';
    document.querySelectorAll('[data-order-status]').forEach(select => select.addEventListener('change', async () => {
      try { const reason = select.value === 'rejected' ? (window.prompt('Optional reason for rejecting this order:') || '') : ''; await api(`/api/admin/orders/${select.dataset.orderStatus}`, { method: 'PATCH', body: JSON.stringify({ status: select.value, reason }) }); await loadAll(); }
      catch (error) { window.alert(error.message); await loadAll().catch(() => {}); }
    }));
    document.querySelectorAll('[data-accept-order]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api(`/api/admin/orders/${button.dataset.acceptOrder}`, { method: 'PATCH', body: JSON.stringify({ status: 'accepted' }) });
        await loadAll();
      } catch (error) {
        announce(`Could not accept order #${button.dataset.acceptOrder}: ${error.message}`);
        button.disabled = false;
      }
    }));
    document.querySelectorAll('[data-delete-order]').forEach(button => button.addEventListener('click', async () => {
      if (!window.confirm('Remove this order permanently?')) return;
      try { await api(`/api/admin/orders/${button.dataset.deleteOrder}`, { method: 'DELETE' }); await loadAll(); }
      catch (error) { window.alert(error.message); }
    }));
  }

  function renderReservations() {
    const reservations = state.reservationDateFilter ? state.reservations.filter(item => item.reservation_date === state.reservationDateFilter) : state.reservations;
    $('reservationsDateFilter').hidden = !state.reservationDateFilter;
    $('reservationsList').innerHTML = reservations.length ? newestFirst(reservations).map(item => {
      const customerType = ['first-time', 'returning'].includes(item.customer_type) ? item.customer_type : 'unknown';
      const customerTypeLabel = customerType === 'first-time' ? 'First-time customer' : customerType === 'returning' ? 'Returning customer' : 'Unknown';
      return `<article class="admin-record admin-reservation-record ${item.status === 'pending' ? 'is-pending' : ''}"><div class="admin-reservation-information"><strong>Reservation #${item.id} · ${escapeHtml(item.reservation_date)} at ${escapeHtml(item.reservation_time)}</strong><p>${Number(item.guests) || 0} guests · ${escapeHtml(item.purpose || 'No purpose provided')}</p><p>${escapeHtml(item.notes || 'No additional notes')}</p><p>Requested ${escapeHtml(item.created_at || '')}${item.rejection_reason ? ` · Reason: ${escapeHtml(item.rejection_reason)}` : ''}</p></div><div class="admin-reservation-customer"><h3>Customer information</h3><p><strong>${escapeHtml(item.name)}</strong> <span class="admin-customer-badge is-${customerType}">${customerTypeLabel}</span></p><p><a href="tel:${escapeHtml(item.phone)}">${escapeHtml(item.phone)}</a></p><p><a href="mailto:${escapeHtml(item.email)}">${escapeHtml(item.email)}</a></p></div><div class="admin-record-actions"><label class="admin-action-label">Status<select data-reservation-status="${item.id}"><option value="pending" ${item.status === 'pending' ? 'selected' : ''}>pending</option><option value="confirmed" ${item.status === 'confirmed' ? 'selected' : ''}>confirmed</option><option value="rejected" ${item.status === 'rejected' ? 'selected' : ''}>rejected</option><option value="cancelled" ${item.status === 'cancelled' ? 'selected' : ''}>cancelled</option></select></label><button class="admin-danger" type="button" data-delete-reservation="${item.id}">Remove</button></div></article>`;
    }).join('') : `<p class="admin-empty">${state.reservationDateFilter ? 'No reservations scheduled for today.' : 'No reservations yet.'}</p>`;
    document.querySelectorAll('[data-reservation-status]').forEach(select => select.addEventListener('change', async () => {
      try { const reason = select.value === 'rejected' ? (window.prompt('Optional reason for rejecting this reservation:') || '') : ''; await api(`/api/admin/reservations/${select.dataset.reservationStatus}`, { method: 'PATCH', body: JSON.stringify({ status: select.value, reason }) }); await loadAll(); }
      catch (error) { window.alert(error.message); await loadAll().catch(() => {}); }
    }));
    document.querySelectorAll('[data-delete-reservation]').forEach(button => button.addEventListener('click', async () => {
      if (!window.confirm('Remove this reservation permanently?')) return;
      try { await api(`/api/admin/reservations/${button.dataset.deleteReservation}`, { method: 'DELETE' }); await loadAll(); }
      catch (error) { window.alert(error.message); }
    }));
  }

  function renderInquiries() {
    $('inquiriesList').innerHTML = state.inquiries.length ? state.inquiries.map(item => `<article class="admin-record"><div><strong>${escapeHtml(item.name)} · ${escapeHtml(item.purpose)}</strong><p>${escapeHtml(item.phone)} · ${escapeHtml(item.email)}</p><p>${escapeHtml(item.message || 'No additional details provided')}</p></div></article>`).join('') : '<p class="admin-empty">No event inquiries yet.</p>';
  }

  function renderEmailQueue() {
    $('emailList').innerHTML = state.notifications.length ? state.notifications.map(item => `<article class="admin-record"><div class="admin-record-details"><strong>${escapeHtml(item.subject)}</strong><p>${escapeHtml(item.recipient)} · ${escapeHtml(item.status)} · ${escapeHtml(item.created_at)}</p>${item.last_error ? `<p>${escapeHtml(item.last_error)}</p>` : ''}</div>${item.status !== 'sent' ? `<button type="button" class="admin-secondary" data-retry-email="${item.id}">Retry email</button>` : ''}</article>`).join('') : '<p class="admin-empty">No notification emails have been queued.</p>';
    $('emailList').querySelectorAll('[data-retry-email]').forEach(button => button.addEventListener('click', async () => {
      try { await api(`/api/admin/notifications/${button.dataset.retryEmail}/retry`, { method: 'POST' }); await loadAll(); }
      catch (error) { window.alert(error.message); }
    }));
  }

  function renderDeliveryPostcodes() {
    const list = $('deliveryPostcodeList');
    list.innerHTML = state.deliveryPostcodes.length
      ? state.deliveryPostcodes.map(item => `<div class="admin-postcode-item"><strong>${escapeHtml(item.postcode)}</strong><span>${escapeHtml(item.country)}</span><button class="admin-secondary" type="button" data-remove-delivery-postcode="${escapeHtml(item.postcode)}" data-delivery-country="${escapeHtml(item.country)}">Remove</button></div>`).join('')
      : '<p class="admin-empty">No approved postcodes. Delivery orders remain unavailable until you add one.</p>';
    list.querySelectorAll('[data-remove-delivery-postcode]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api('/api/admin/delivery-postcodes', {
          method: 'DELETE',
          body: JSON.stringify({ postcode: button.dataset.removeDeliveryPostcode, country: button.dataset.deliveryCountry })
        });
        $('deliveryPostcodeMessage').textContent = 'Approved postcode removed.';
        await loadAll();
      } catch (error) {
        $('deliveryPostcodeMessage').textContent = error.message;
        button.disabled = false;
      }
    }));
  }

  function renderEmailFailures() {
    const unresolved = state.notifications.filter(item => item.status !== 'sent' && (
      item.status === 'failed' || Number(item.attempts) > 0
    ));
    const waitingForConfiguration = !state.emailConfigured && state.notifications.some(item =>
      item.status === 'pending' && Number(item.attempts) === 0 && /^(order|reservation)-/.test(item.event_key || '')
    );
    const alert = $('emailFailureAlerts');
    const messages = [];
    if (waitingForConfiguration) {
      messages.push('<p class="admin-email-config-warning"><strong>Email is not configured.</strong> Order and reservation emails are saved but cannot be sent until SMTP is configured.</p>');
      messages.push('<button class="admin-secondary" type="button" data-open-email-queue>Review email queue</button>');
    }
    if (unresolved.length) {
      const failures = unresolved.map(item => {
        const event = /^(order|reservation)-(\d+)-/.exec(item.event_key || '');
        const kind = event?.[1] === 'order' ? `Order #${event[2]}` : event?.[1] === 'reservation' ? `Reservation #${event[2]}` : 'Email notification';
        const signature = `${item.id}:${item.last_error || item.status}`;
        if (state.hasLoaded && item.status === 'failed' && !state.emailFailureAnnouncements.has(signature)) {
          state.emailFailureAnnouncements.add(signature);
          announce(`${kind} email could not be delivered. Review the email warning for details.`);
        }
        return `<article class="admin-email-failure"><div><strong>${kind} email not delivered</strong><p><span>${escapeHtml(item.subject)}</span> · To ${escapeHtml(item.recipient)} · ${Number(item.attempts) || 0} attempts</p><p class="admin-email-error">${escapeHtml(item.last_error || (item.status === 'pending' ? 'Retry is queued.' : 'Delivery has not completed.'))}</p></div><button class="admin-secondary" type="button" data-retry-email="${item.id}">Retry email</button></article>`;
      });
      messages.push(...failures);
      messages.push('<button class="admin-secondary" type="button" data-open-email-queue>Review email queue</button>');
    }
    const html = messages.join('');
    if (alert.innerHTML !== html) {
      alert.innerHTML = html;
      alert.querySelectorAll('[data-retry-email]').forEach(button => button.addEventListener('click', async () => {
        button.disabled = true;
        try { await api(`/api/admin/notifications/${button.dataset.retryEmail}/retry`, { method: 'POST' }); await loadAll(); }
        catch (error) { announce(`Could not retry email: ${error.message}`); button.disabled = false; }
      }));
      alert.querySelector('[data-open-email-queue]')?.addEventListener('click', () => activatePanel('emailPanel'));
    }
    alert.hidden = messages.length === 0;
  }

  function openMenuForm(item = null) {
    $('menuForm').hidden = false;
    $('menuFormTitle').textContent = item ? 'Edit menu item' : 'Add menu item';
    $('menuId').value = item?.id || '';
    $('menuName').value = item?.name || '';
    $('menuNameFa').value = item?.name_fa || '';
    $('menuDescription').value = item?.description || '';
    $('menuPrice').value = item ? item.price_cents / 100 : '';
    $('menuCategory').value = item?.category || '';
    $('menuImage').value = item?.image || '';
    $('menuImageFile').value = '';
    $('menuImagePreview').src = menuImageDisplayUrl(item?.image || '');
    $('menuImagePreview').hidden = !item?.image;
    $('removeMenuImage').hidden = !item?.image;
    $('menuImageMessage').textContent = item?.image ? 'Current menu photo. Choose another photo to replace it.' : 'Choose a photo from your device or photo library (maximum 4 MB).';
    $('menuSortOrder').value = item?.sort_order || 0;
    let itemDays = [];
    try { itemDays = item ? JSON.parse(item.available_days || '[]') : []; } catch (_) { itemDays = []; }
    document.querySelectorAll('[data-menu-day]').forEach(input => { input.checked = itemDays.includes(input.value); });
    $('menuAvailable').checked = item ? Boolean(item.available) : true;
    $('menuAvailabilityLabel').textContent = $('menuAvailable').checked ? 'Visible on public menu · In stock' : 'Hidden from public menu · Sold out';
    requestAnimationFrame(() => {
      $('menuForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('menuName').focus({ preventScroll: true });
    });
  }

  const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  function renderBusinessHours(hours) {
    state.hours = hours;
    const root = $('restaurantHours');
    if (!root) return;
    if (state.hoursDirty) return;
    root.innerHTML = weekDays.map(day => {
      const setting = hours[day];
      return `<div class="admin-hours-row ${setting.open ? '' : 'is-closed'}" data-hours-row="${day}"><strong>${day[0].toUpperCase()}${day.slice(1)}</strong><label class="admin-hours-service"><input type="checkbox" data-hours-open ${setting.open ? 'checked' : ''}> Open</label><label>Opens<input type="time" data-hours-opens value="${escapeHtml(setting.opens)}"></label><label>Closes<input type="time" data-hours-closes value="${escapeHtml(setting.closes)}"></label><label class="admin-hours-service"><input type="checkbox" data-hours-orders ${setting.orders ? 'checked' : ''}> Orders</label><label class="admin-hours-service"><input type="checkbox" data-hours-reservations ${setting.reservations ? 'checked' : ''}> Reservations</label></div>`;
    }).join('');
    root.querySelectorAll('.admin-hours-row input').forEach(input => input.addEventListener('input', () => { state.hoursDirty = true; }));
    root.querySelectorAll('[data-hours-open]').forEach(input => input.addEventListener('change', () => { state.hoursDirty = true; input.closest('.admin-hours-row').classList.toggle('is-closed', !input.checked); }));
  }

  function currentHoursForm() {
    return Object.fromEntries(weekDays.map(day => {
      const row = $(`hoursPanel`).querySelector(`[data-hours-row="${day}"]`);
      return [day, { open: row.querySelector('[data-hours-open]').checked, opens: row.querySelector('[data-hours-opens]').value, closes: row.querySelector('[data-hours-closes]').value, orders: row.querySelector('[data-hours-orders]').checked, reservations: row.querySelector('[data-hours-reservations]').checked }];
    }));
  }

  function announce(text) {
    let toast = $('adminToast');
    if (!toast) { toast = document.createElement('div'); toast.id = 'adminToast'; toast.className = 'admin-toast'; toast.setAttribute('role', 'status'); document.body.appendChild(toast); }
    toast.textContent = text;
    toast.classList.add('is-visible');
    window.setTimeout(() => toast.classList.remove('is-visible'), 4200);
  }

  let audioContext;
  let activeAlert = [];
  function getAudioContext() {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return null;
    audioContext ||= new Audio();
    return audioContext;
  }

  async function enableNotificationAudio() {
    const context = getAudioContext();
    if (!context) return false;
    await context.resume();
    return context.state === 'running';
  }

  async function playNotificationSound(test = false) {
    if (!test && !$('adminSoundEnabled')?.checked) return;
    if (!audioContext) {
      if (!test && !state.soundBlockedNoticeShown) {
        state.soundBlockedNoticeShown = true;
        announce('Tap Test sound in Notification Settings once to allow sound alerts in this browser.');
      }
      return;
    }
    if (audioContext.state !== 'running') {
      try {
        await audioContext.resume();
      } catch (_) {
        if (!state.soundBlockedNoticeShown) announce('Sound is blocked by this browser. Tap Test sound to enable it; visual notifications will still work.');
        state.soundBlockedNoticeShown = true;
        return;
      }
    }
    if (audioContext.state !== 'running') {
      if (!state.soundBlockedNoticeShown) announce('Sound is blocked by this browser. Tap Test sound to enable it; visual notifications will still work.');
      state.soundBlockedNoticeShown = true;
      return;
    }
    state.soundBlockedNoticeShown = false;
    stopNotificationSound();
    const start = audioContext.currentTime;
    const duration = 7;
    const end = start + duration;
    const master = audioContext.createGain();
    const compressor = audioContext.createDynamicsCompressor();
    const volume = Number($('adminSoundVolume')?.value ?? 100) / 100;
    master.gain.setValueAtTime(volume, start);
    // A restrained limiter keeps the full-level setting clear without clipping.
    compressor.threshold.setValueAtTime(-6, start);
    compressor.knee.setValueAtTime(6, start);
    compressor.ratio.setValueAtTime(8, start);
    compressor.attack.setValueAtTime(0.003, start);
    compressor.release.setValueAtTime(0.12, start);
    for (let pairStart = start; pairStart < end; pairStart += 0.9) {
      [1047, 1319].forEach((frequency, index) => {
        const noteStart = pairStart + index * 0.16;
        if (noteStart >= end) return;
        const noteEnd = Math.min(noteStart + 0.34, end);
        [[1, 0.62], [2.76, 0.18], [5.4, 0.07]].forEach(([partial, level]) => {
          const oscillator = audioContext.createOscillator();
          const envelope = audioContext.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(frequency * partial, noteStart);
          envelope.gain.setValueAtTime(0.0001, noteStart);
          envelope.gain.exponentialRampToValueAtTime(level, noteStart + 0.008);
          envelope.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
          oscillator.connect(envelope);
          envelope.connect(master);
          oscillator.start(noteStart);
          oscillator.stop(noteEnd);
          activeAlert.push(oscillator);
        });
      });
    }
    master.connect(compressor);
    compressor.connect(audioContext.destination);
    const alertOscillators = activeAlert;
    let remaining = alertOscillators.length;
    alertOscillators.forEach(oscillator => oscillator.addEventListener('ended', () => {
      remaining -= 1;
      if (activeAlert === alertOscillators && remaining === 0) activeAlert = [];
    }, { once: true }));
  }

  function stopNotificationSound() {
    activeAlert.forEach(oscillator => {
      try { oscillator.stop(); } catch (error) { if (error.name !== 'InvalidStateError') throw error; }
    });
    activeAlert = [];
  }

  function updateBrowserNotificationStatus() {
    const option = $('adminBrowserNotifications');
    const status = $('browserNotificationStatus');
    state.notificationSupported = 'Notification' in window;
    option.disabled = !state.notificationSupported || Notification.permission === 'denied';
    option.checked = state.notificationSupported && Notification.permission === 'granted';
    state.notificationGranted = option.checked;
    status.textContent = !state.notificationSupported
      ? 'Browser notifications are not supported here.'
      : Notification.permission === 'granted'
        ? 'Browser notifications are enabled.'
        : Notification.permission === 'denied'
          ? 'Notifications are blocked by browser settings. Allow them for this site in your browser settings.'
          : 'Browser notifications are off. Enable them here when prompted.';
  }

  function notifyNewRecords(previous, next) {
    if (!state.hasLoaded) return;
    const found = [
      ...next.orders.filter(item => item.status === 'new' && !previous.orders.some(old => old.id === item.id)).map(item => `New ${item.type === 'delivery' ? 'delivery' : 'takeaway'} order #${item.id}`),
      ...next.reservations.filter(item => item.status === 'pending' && !previous.reservations.some(old => old.id === item.id)).map(item => `New reservation #${item.id}`)
    ];
    if (found.length) {
      announce(found.join(' · '));
      playNotificationSound();
      if (state.notificationGranted) found.forEach(sendBrowserNotification);
    }
  }

  function sendBrowserNotification(message) {
    const options = { body: message, icon: '/icons/pwa-192.png', tag: `mamanpaz-${message}` };
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then(registration => {
        if (registration) return registration.showNotification('Mamanpaz staff update', options);
        if ('Notification' in window && Notification.permission === 'granted') new Notification('Mamanpaz staff update', options);
      }).catch(() => {
        if ('Notification' in window && Notification.permission === 'granted') new Notification('Mamanpaz staff update', options);
      });
    } else if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Mamanpaz staff update', options);
    }
  }

  function setLiveStatus(message, isOffline) {
    const status = $('adminLiveStatus');
    status.textContent = message;
    status.classList.toggle('is-offline', isOffline);
  }

  async function loadAll() {
    if (state.refreshing) return;
    state.refreshing = true;
    try {
    const previous = { orders: state.orders, reservations: state.reservations, inquiries: state.inquiries };
    const [menu, orders, reservations, inquiries, delivery, postcodes, business, notifications] = await Promise.all([api('/api/admin/menu'), api('/api/admin/orders'), api('/api/admin/reservations'), api('/api/admin/event-inquiries'), api('/api/settings/delivery'), api('/api/admin/delivery-postcodes'), api('/api/settings/business-hours'), api('/api/admin/notifications')]);
    state.menu = menu.items;
    state.orders = orders.orders;
    state.testNotifications = state.orders.some(order => order.test_mode) ? (await api('/api/admin/test-notifications')).notifications : [];
    state.reservations = reservations.reservations;
    state.inquiries = inquiries.inquiries;
    state.notifications = notifications.notifications;
    state.deliveryPostcodes = postcodes.postcodes;
    state.emailConfigured = Boolean(notifications.configured);
    state.todayWeekday = business.today;
    state.todayDate = business.todayDate;
    $('emailConfigMessage').textContent = notifications.configured ? 'Unsent emails remain queued and can be retried.' : 'Email is not configured. Order and reservation emails remain queued until SMTP settings are added.';
    $('deliveryOpen').checked = delivery.open;
    renderBusinessHours(business.hours);
    renderOverview(); renderMenu(); renderOrders(); renderReservations(); renderInquiries(); renderEmailQueue(); renderEmailFailures(); renderDeliveryPostcodes();
    notifyNewRecords(previous, { orders: state.orders, reservations: state.reservations, inquiries: state.inquiries });
    state.hasLoaded = true;
    setLiveStatus(`Live updates up to date · checked ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, false);
    } catch (error) {
      setLiveStatus('Connection lost · reconnecting…', true);
      throw error;
    } finally { state.refreshing = false; }
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
    document.querySelectorAll('.admin-tab').forEach(tab => tab.addEventListener('click', () => activatePanel(tab.dataset.panel)));
    $('todayOrdersStat').addEventListener('click', () => {
      state.orderDateFilter = state.todayDate;
      renderOrders();
      activatePanel('ordersPanel');
    });
    $('todayReservationsStat').addEventListener('click', () => {
      state.reservationDateFilter = state.todayDate;
      renderReservations();
      activatePanel('reservationsPanel');
    });
    $('clearOrdersDateFilter').addEventListener('click', () => { state.orderDateFilter = ''; renderOrders(); });
    $('clearReservationsDateFilter').addEventListener('click', () => { state.reservationDateFilter = ''; renderReservations(); });
    const settings = $('notificationSettings');
    const openSettings = () => { settings.hidden = false; $('closeNotificationSettings').focus(); };
    const closeSettings = () => { settings.hidden = true; $('openNotificationSettings').focus(); };
    $('openNotificationSettings').addEventListener('click', openSettings);
    $('closeNotificationSettings').addEventListener('click', closeSettings);
    settings.addEventListener('click', event => { if (event.target === settings) closeSettings(); });
    settings.addEventListener('keydown', event => { if (event.key === 'Escape') closeSettings(); });
    $('newMenuItem').addEventListener('click', () => openMenuForm());
    $('menuCategoryFilter').addEventListener('change', renderMenu);
    $('menuSearch').addEventListener('input', renderMenu);
    $('cancelMenu').addEventListener('click', () => { $('menuForm').hidden = true; });
    $('removeMenuImage').addEventListener('click', () => {
      $('menuImage').value = '';
      $('menuImageFile').value = '';
      $('menuImagePreview').removeAttribute('src');
      $('menuImagePreview').hidden = true;
      $('removeMenuImage').hidden = true;
      $('menuImageMessage').textContent = 'Photo removed. Save the item to apply this change.';
    });
    $('menuImageFile').addEventListener('change', async () => {
      const file = $('menuImageFile').files[0];
      if (!file) return;
      if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type) || file.size > 4 * 1024 * 1024) {
        $('menuImageMessage').textContent = 'Choose a PNG, JPG, WEBP, or GIF image smaller than 4 MB.';
        $('menuImageFile').value = '';
        return;
      }
      $('menuImageMessage').textContent = 'Uploading photo…';
      const saveButton = $('menuForm').querySelector('[type="submit"]');
      saveButton.disabled = true;
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Could not read this photo.'));
          reader.readAsDataURL(file);
        });
        const result = await api('/api/admin/menu-image', { method: 'POST', body: JSON.stringify({ dataUrl }) });
        $('menuImage').value = result.image;
        $('menuImagePreview').src = result.image;
        $('menuImagePreview').hidden = false;
        $('removeMenuImage').hidden = false;
        $('menuImageMessage').textContent = 'Photo uploaded. Save the item to publish it on the menu.';
      } catch (error) {
        $('menuImageMessage').textContent = error.message;
      } finally {
        saveButton.disabled = false;
      }
    });
    $('menuForm').addEventListener('submit', async event => {
      event.preventDefault();
      const id = $('menuId').value;
      const payload = { name: $('menuName').value, nameFa: $('menuNameFa').value, description: $('menuDescription').value, price: $('menuPrice').value, category: $('menuCategory').value, image: $('menuImage').value, sortOrder: $('menuSortOrder').value, available: $('menuAvailable').checked, availableDays: [...document.querySelectorAll('[data-menu-day]:checked')].map(input => input.value) };
      try { await api(id ? `/api/admin/menu/${id}` : '/api/admin/menu', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) }); $('menuForm').hidden = true; await loadAll(); } catch (error) { $('menuMessage').textContent = error.message; }
    });
    $('menuAvailable').addEventListener('change', () => {
      $('menuAvailabilityLabel').textContent = $('menuAvailable').checked ? 'Visible on public menu · In stock' : 'Hidden from public menu · Sold out';
    });
    $('saveDelivery').addEventListener('click', async () => { try { await api('/api/admin/settings/delivery', { method: 'PATCH', body: JSON.stringify({ open: $('deliveryOpen').checked }) }); $('deliveryMessage').textContent = 'Delivery status saved.'; } catch (error) { $('deliveryMessage').textContent = error.message; } });
    $('deliveryPostcodeForm').addEventListener('submit', async event => {
      event.preventDefault();
      const postcode = $('deliveryPostcode').value;
      const country = $('deliveryPostcodeCountry').value;
      try {
        const result = await api('/api/admin/delivery-postcodes', { method: 'POST', body: JSON.stringify({ postcode, country }) });
        $('deliveryPostcode').value = '';
        $('deliveryPostcodeMessage').textContent = result.added ? 'Approved postcode added.' : 'That postcode is already approved.';
        await loadAll();
      } catch (error) {
        $('deliveryPostcodeMessage').textContent = error.message;
      }
    });

    $('saveBusinessHours').addEventListener('click', async () => {
      try { const result = await api('/api/admin/settings/business-hours', { method: 'PATCH', body: JSON.stringify({ hours: currentHoursForm() }) }); state.hoursDirty = false; renderBusinessHours(result.hours); $('hoursMessage').textContent = 'Opening hours saved.'; await loadAll(); }
      catch (error) { $('hoursMessage').textContent = error.message; }
    });

    $('adminSoundEnabled').checked = localStorage.getItem('mamanpaz_admin_sound') !== 'off';
    const volumeControl = $('adminSoundVolume');
    const volumeOutput = $('adminSoundVolumeValue');
    const savedVolume = Number(localStorage.getItem('mamanpaz_admin_sound_volume'));
    volumeControl.value = Number.isFinite(savedVolume) && localStorage.getItem('mamanpaz_admin_sound_volume') !== null ? String(Math.max(0, Math.min(100, savedVolume))) : '100';
    volumeOutput.value = `${volumeControl.value}%`;
    volumeControl.addEventListener('input', () => {
      volumeOutput.value = `${volumeControl.value}%`;
      localStorage.setItem('mamanpaz_admin_sound_volume', volumeControl.value);
    });
    updateBrowserNotificationStatus();
    $('adminSoundEnabled').addEventListener('change', async () => {
      localStorage.setItem('mamanpaz_admin_sound', $('adminSoundEnabled').checked ? 'on' : 'off');
      if (!$('adminSoundEnabled').checked) {
        stopNotificationSound();
        $('notificationSettingsMessage').textContent = 'Sound alerts are off.';
        return;
      }
      try {
        const enabled = await enableNotificationAudio();
        if (enabled) state.soundBlockedNoticeShown = false;
        $('notificationSettingsMessage').textContent = enabled
          ? 'Sound alerts are on.'
          : 'Sound is blocked by this browser. Use Test sound after interacting with the page.';
      } catch (error) {
        $('notificationSettingsMessage').textContent = `Sound could not be enabled: ${error.message}`;
      }
    });
    $('testAdminSound').addEventListener('click', async () => {
      try {
        if (!await enableNotificationAudio()) {
          $('notificationSettingsMessage').textContent = 'This browser cannot play sound alerts.';
          return;
        }
        state.soundBlockedNoticeShown = false;
        await playNotificationSound(true);
        $('notificationSettingsMessage').textContent = 'Test sound played. No order or notification was created.';
      } catch (error) {
        $('notificationSettingsMessage').textContent = `Test sound could not play: ${error.message}`;
      }
    });
    $('stopAdminSound').addEventListener('click', () => {
      stopNotificationSound();
      $('notificationSettingsMessage').textContent = 'Sound stopped.';
    });
    $('adminBrowserNotifications').addEventListener('change', async () => {
      if (!$('adminBrowserNotifications').checked) {
        updateBrowserNotificationStatus();
        return;
      }
      try {
        await Notification.requestPermission();
        updateBrowserNotificationStatus();
      } catch (error) {
        $('browserNotificationStatus').textContent = `Could not request notification permission: ${error.message}`;
        $('adminBrowserNotifications').checked = false;
      }
    });
    let installPrompt;
    window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('installDashboard').hidden = false; });
    $('installDashboard').addEventListener('click', async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('installDashboard').hidden = true; });

    api('/api/admin/me').then(async () => { showDashboard(); await loadAll(); }).catch(() => showLogin());
    window.setInterval(() => { if (!document.hidden && !$('adminDashboard').hidden) loadAll().catch(() => {}); }, 8000);
    window.addEventListener('offline', () => setLiveStatus('Offline · live updates paused', true));
    window.addEventListener('online', () => {
      if (document.hidden || $('adminDashboard').hidden) return;
      setLiveStatus('Connection restored · checking…', true);
      loadAll().catch(() => {});
    });
    document.addEventListener('visibilitychange', () => {
      if ($('adminDashboard').hidden) return;
      if (document.hidden) setLiveStatus('Live updates paused · dashboard hidden', true);
      else loadAll().catch(() => {});
    });
  }

  document.addEventListener('DOMContentLoaded', setup);
})();
