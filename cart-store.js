/* Shared, validated cart storage used by the menu and checkout pages. */
(() => {
  const KEY = 'mamanpaz_cart_v1';

  function normalize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const cart = {};
    for (const [oldKey, raw] of Object.entries(value).slice(0, 100)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const quantity = Number(raw.qty);
      const price = Number(raw.price);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 30 || !Number.isFinite(price) || price < 0 || price > 10000) continue;
      if (raw.kind === 'extra') {
        const key = oldKey === 'extra_bread' ? oldKey : `extra:${String(raw.id || oldKey).slice(0, 50)}`;
        cart[key] = { id: raw.id ?? key, kind: 'extra', name: String(raw.name || 'Extra').slice(0, 120), price, qty: quantity };
        continue;
      }
      const id = Number(raw.id);
      if (!Number.isInteger(id) || id < 1) continue;
      const sauceIds = [...new Set((Array.isArray(raw.sauceIds) ? raw.sauceIds : raw.sauceId == null ? [] : [raw.sauceId]).map(Number))];
      if (sauceIds.length > 2 || sauceIds.some(sauceId => !Number.isInteger(sauceId) || sauceId < 1)) continue;
      const breadPerItem = Boolean(raw.breadPerItem);
      const key = `${id}:s${sauceIds.join('.') || 'none'}:b${breadPerItem ? 1 : 0}`;
      const sauceNames = (Array.isArray(raw.sauceNames) ? raw.sauceNames : raw.sauceName ? [raw.sauceName] : []).slice(0, 2).map(name => String(name).slice(0, 100));
      const item = {
        id, name: String(raw.name || 'Menu item').slice(0, 120), price, qty: quantity,
        img: typeof raw.img === 'string' ? raw.img.slice(0, 300) : null,
        category: String(raw.category || '').slice(0, 40), sauceIds, sauceNames,
        sauceId: sauceIds[0] || null, sauceName: sauceNames.join(', '), breadPerItem,
        breadPrice: breadPerItem ? 1 : 0
      };
      item.saucePrice = sauceIds.length * 0.5 + item.breadPrice;
      if (cart[key]) cart[key].qty = Math.min(30, cart[key].qty + quantity);
      else cart[key] = item;
    }
    return cart;
  }

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      const clean = normalize(raw ? JSON.parse(raw) : {});
      const serialized = JSON.stringify(clean);
      if (raw !== serialized) localStorage.setItem(KEY, serialized);
      return clean;
    } catch (_) {
      try { localStorage.setItem(KEY, '{}'); } catch (_) {}
      return {};
    }
  }

  function write(cart) {
    const clean = normalize(cart);
    localStorage.setItem(KEY, JSON.stringify(clean));
    return clean;
  }

  window.MamanpazCart = Object.freeze({ key: KEY, read, write, normalize });
})();
