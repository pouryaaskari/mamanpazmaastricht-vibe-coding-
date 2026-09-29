require('dotenv').config();
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const Database = require('better-sqlite3');

const app = express();
const port = Number(process.env.PORT || 3000);
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'mamanpaz.sqlite'));
const sessions = new Map();
const sessionMaxAge = 1000 * 60 * 60 * 8;
const menuCategories = ['kebab', 'stews', 'rice', 'side', 'starters', 'wraps', 'desserts', 'drinks', 'sauces'];
const allowedReservationTimes = new Set(Array.from({ length: 22 }, (_, index) => {
  const minutes = (16 * 60 + 30) + index * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}));

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

const requestWindows = new Map();
function rateLimit(limit, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const hits = (requestWindows.get(key) || []).filter(time => time > now - windowMs);
    if (hits.length >= limit) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    hits.push(now);
    requestWindows.set(key, hits);
    next();
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expected] = storedHash.split(':');
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return expected && actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, expiresAt: Date.now() + sessionMaxAge });
  return token;
}

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  const entry = cookies.find(cookie => cookie.trim().startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.trim().slice(name.length + 1)) : '';
}

function getSession(req) {
  const token = getCookie(req, 'mamanpaz_admin_session') || req.get('x-admin-session');
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + sessionMaxAge;
  return { token, ...session };
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Staff login required.' });
  req.adminSession = session;
  next();
}

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength);
}

function parsePrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0 || price > 10000) return null;
  return Math.round(price * 100) / 100;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validPhone(value) {
  return /^[0-9+()\s-]{6,40}$/.test(value);
}

function validFutureDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Do not use toISOString here: in Maastricht it converts local midnight to
  // the previous UTC day and rejects otherwise valid reservation dates.
  const localValue = Number.isNaN(date.getTime()) ? '' : [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
  return date >= today && localValue === value;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS staff_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    category TEXT NOT NULL,
    image TEXT NOT NULL DEFAULT '',
    available INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS restaurant_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL CHECK (type IN ('pickup', 'delivery')),
    address TEXT NOT NULL DEFAULT '',
    items_json TEXT NOT NULL,
    total_cents INTEGER NOT NULL,
    order_time TEXT NOT NULL DEFAULT 'asap',
    payment_method TEXT NOT NULL DEFAULT 'cash',
    status TEXT NOT NULL DEFAULT 'new',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    reservation_date TEXT NOT NULL,
    reservation_time TEXT NOT NULL,
    guests INTEGER NOT NULL,
    purpose TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS event_inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    purpose TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Additive migration for databases created before checkout time/payment were saved.
const orderColumns = new Set(db.prepare('PRAGMA table_info(orders)').all().map(column => column.name));
if (!orderColumns.has('order_time')) db.exec("ALTER TABLE orders ADD COLUMN order_time TEXT NOT NULL DEFAULT 'asap'");
if (!orderColumns.has('payment_method')) db.exec("ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'cash'");

function seedExistingMenu() {
  if (db.prepare('SELECT COUNT(*) AS count FROM menu_items').get().count > 0) return;
  const source = fs.readFileSync(path.join(__dirname, 'menu.html'), 'utf8');
  const insert = db.prepare('INSERT INTO menu_items (name, description, price_cents, category, image, available, sort_order) VALUES (?, ?, ?, ?, ?, 1, ?)');
  const sections = [...source.matchAll(/<section id="([^"]+)" class="menu-section">([\s\S]*?)<\/section>/g)];
  const seed = db.transaction(() => {
    sections.forEach(([, category, section]) => {
      const matches = [...section.matchAll(/<span class="item-en">([^<]+)<\/span>[\s\S]*?<span class="price">\s*([0-9]+,[0-9]{2}) EUR/g)];
      matches.forEach((match, index) => {
        const [, rawName, price] = match;
        const name = rawName.trim();
        const start = section.lastIndexOf('<div class="menu-item"', match.index);
        const nextStart = index + 1 < matches.length ? section.lastIndexOf('<div class="menu-item"', matches[index + 1].index) : section.length;
        const block = section.slice(Math.max(0, start), nextStart);
        const description = block.match(/<div class="menu-desc">([^<]*)<\/div>/)?.[1]?.trim() || '';
        const image = block.match(/<img class="menu-item-image" src="([^"]+)"/)?.[1] || '';
        if (name && menuCategories.includes(category)) insert.run(name, description, Math.round(Number(price.replace(',', '.')) * 100), category, image, index);
      });
    });
  });
  seed();
}

seedExistingMenu();

const staffCount = db.prepare('SELECT COUNT(*) AS count FROM staff_users').get().count;
if (staffCount === 0 && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
  db.prepare('INSERT INTO staff_users (username, password_hash, role) VALUES (?, ?, ?)').run(
    process.env.ADMIN_USERNAME,
    hashPassword(process.env.ADMIN_PASSWORD),
    'admin'
  );
  console.log(`Created initial staff account for ${process.env.ADMIN_USERNAME}.`);
} else if (staffCount === 0) {
  console.warn('No staff account exists. Create a .env file with ADMIN_USERNAME and ADMIN_PASSWORD, then restart the server.');
}

app.post('/api/auth/login', rateLimit(10, 15 * 60 * 1000), (req, res) => {
  const username = cleanText(req.body.username, 100);
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT id, username, password_hash, role FROM staff_users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: 'Invalid staff credentials.' });
  const token = createSession(user.id);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `mamanpaz_admin_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionMaxAge / 1000}${secure}`);
  res.json({ user: { username: user.username, role: user.role } });
});

app.post('/api/auth/logout', requireAdmin, (req, res) => {
  sessions.delete(req.adminSession.token);
  res.setHeader('Set-Cookie', 'mamanpaz_admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.status(204).end();
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT username, role FROM staff_users WHERE id = ?').get(req.adminSession.userId);
  res.json({ user });
});

app.get('/api/menu', (req, res) => {
  const items = db.prepare('SELECT id, name, description, price_cents, category, image, available, sort_order FROM menu_items WHERE available = 1 ORDER BY category, sort_order, id').all();
  res.json({ items });
});

app.get('/api/admin/menu', requireAdmin, (req, res) => {
  res.json({ items: db.prepare('SELECT * FROM menu_items ORDER BY category, sort_order, id').all() });
});

app.post('/api/admin/menu', requireAdmin, (req, res) => {
  const name = cleanText(req.body.name, 120);
  const description = cleanText(req.body.description, 1000);
  const category = cleanText(req.body.category, 40);
  const image = cleanText(req.body.image, 300);
  const price = parsePrice(req.body.price);
  if (!name || !menuCategories.includes(category) || price === null) return res.status(400).json({ error: 'Name, a supported category, and a valid price are required.' });
  const result = db.prepare('INSERT INTO menu_items (name, description, price_cents, category, image, available, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)').run(name, description, Math.round(price * 100), category, image, req.body.available === false ? 0 : 1, Number(req.body.sortOrder) || 0);
  res.status(201).json({ item: db.prepare('SELECT * FROM menu_items WHERE id = ?').get(result.lastInsertRowid) });
});

app.patch('/api/admin/menu/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: 'Menu item not found.' });
  const price = req.body.price === undefined ? current.price_cents / 100 : parsePrice(req.body.price);
  if (price === null) return res.status(400).json({ error: 'Price must be a valid non-negative number.' });
  const item = {
    name: req.body.name === undefined ? current.name : cleanText(req.body.name, 120),
    description: req.body.description === undefined ? current.description : cleanText(req.body.description, 1000),
    category: req.body.category === undefined ? current.category : cleanText(req.body.category, 40),
    image: req.body.image === undefined ? current.image : cleanText(req.body.image, 300),
    available: req.body.available === undefined ? current.available : (req.body.available ? 1 : 0),
    sortOrder: req.body.sortOrder === undefined ? current.sort_order : Number(req.body.sortOrder) || 0
  };
  if (!item.name || !menuCategories.includes(item.category)) return res.status(400).json({ error: 'Name and a supported category are required.' });
  db.prepare('UPDATE menu_items SET name = ?, description = ?, price_cents = ?, category = ?, image = ?, available = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(item.name, item.description, Math.round(price * 100), item.category, item.image, item.available, item.sortOrder, id);
  res.json({ item: db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id) });
});

app.delete('/api/admin/menu/:id', requireAdmin, (req, res) => {
  const result = db.prepare('DELETE FROM menu_items WHERE id = ?').run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'Menu item not found.' });
  res.status(204).end();
});

app.get('/api/settings/delivery', (req, res) => {
  const setting = db.prepare('SELECT value FROM restaurant_settings WHERE key = ?').get('delivery');
  res.json({ open: setting ? setting.value !== 'closed' : true });
});

app.patch('/api/admin/settings/delivery', requireAdmin, (req, res) => {
  const value = req.body.open ? 'open' : 'closed';
  db.prepare('INSERT INTO restaurant_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('delivery', value);
  res.json({ open: value === 'open' });
});

app.post('/api/orders', rateLimit(10, 15 * 60 * 1000), (req, res) => {
  const customerName = cleanText(req.body.customerName, 120);
  const phone = cleanText(req.body.phone, 40);
  const email = cleanText(req.body.email, 160);
  const type = req.body.type === 'delivery' ? 'delivery' : 'pickup';
  const address = cleanText(req.body.address, 300);
  const notes = cleanText(req.body.notes, 1000);
  const orderTime = cleanText(req.body.orderTime, 20);
  const paymentMethod = cleanText(req.body.paymentMethod, 20);
  const requestedItems = Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [];
  if (!customerName || !validPhone(phone) || (email && !validEmail(email)) || !requestedItems.length || !(orderTime === 'asap' || allowedReservationTimes.has(orderTime)) || !['cash', 'tikkie'].includes(paymentMethod)) return res.status(400).json({ error: 'Enter valid contact, order time, payment, and cart details.' });
  const quantities = new Map();
  for (const item of requestedItems) {
    const id = Number(item.id);
    const quantity = Number(item.quantity);
    if (!Number.isInteger(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 30) return res.status(400).json({ error: 'Your cart contains an invalid quantity.' });
    quantities.set(id, (quantities.get(id) || 0) + quantity);
  }
  if ([...quantities.values()].some(quantity => quantity > 30)) return res.status(400).json({ error: 'A maximum of 30 of each item can be ordered.' });
  const ids = [...quantities.keys()];
  const placeholders = ids.map(() => '?').join(', ');
  const menuItems = db.prepare(`SELECT id, name, price_cents, available FROM menu_items WHERE id IN (${placeholders})`).all(...ids);
  if (menuItems.length !== ids.length || menuItems.some(item => !item.available)) return res.status(409).json({ error: 'One or more items are no longer available. Please refresh your cart.' });
  const items = menuItems.map(item => ({ id: item.id, name: item.name, quantity: quantities.get(item.id), priceCents: item.price_cents }));
  const foodTotalCents = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
  const deliveryFeeCents = type === 'delivery' ? 300 : 0;
  const totalCents = foodTotalCents + deliveryFeeCents;
  if (type === 'delivery') {
    const setting = db.prepare('SELECT value FROM restaurant_settings WHERE key = ?').get('delivery');
    if (setting?.value === 'closed') return res.status(409).json({ error: 'Delivery is currently closed.' });
    if (!address) return res.status(400).json({ error: 'A delivery address is required.' });
  }
  const result = db.prepare('INSERT INTO orders (customer_name, phone, email, type, address, items_json, total_cents, order_time, payment_method, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(customerName, phone, email, type, address, JSON.stringify(items), totalCents, orderTime, paymentMethod, notes);
  res.status(201).json({ orderId: result.lastInsertRowid });
});

app.post('/api/reservations', rateLimit(10, 15 * 60 * 1000), (req, res) => {
  const name = cleanText(req.body.name, 120);
  const email = cleanText(req.body.email, 160);
  const phone = cleanText(req.body.phone, 40);
  const reservationDate = cleanText(req.body.date, 20);
  const reservationTime = cleanText(req.body.time, 20);
  const guests = Number(req.body.guests);
  const purpose = cleanText(req.body.purpose, 80);
  const notes = cleanText(req.body.notes, 1000);
  if (!name || !validEmail(email) || !validPhone(phone) || !validFutureDate(reservationDate) || !allowedReservationTimes.has(reservationTime) || !Number.isInteger(guests) || guests < 1 || guests > 30) return res.status(400).json({ error: 'Please enter valid reservation details during opening hours.' });
  const result = db.prepare('INSERT INTO reservations (name, email, phone, reservation_date, reservation_time, guests, purpose, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(name, email, phone, reservationDate, reservationTime, guests, purpose, notes);
  res.status(201).json({ reservationId: result.lastInsertRowid });
});

app.post('/api/event-inquiries', rateLimit(5, 15 * 60 * 1000), (req, res) => {
  const name = cleanText(req.body.name, 120);
  const email = cleanText(req.body.email, 160);
  const phone = cleanText(req.body.phone, 40);
  const purpose = cleanText(req.body.purpose, 80);
  const message = cleanText(req.body.message, 1000);
  if (!name || !validEmail(email) || !validPhone(phone) || !purpose) return res.status(400).json({ error: 'Please complete your name, email, phone number, and occasion.' });
  const result = db.prepare('INSERT INTO event_inquiries (name, email, phone, purpose, message) VALUES (?, ?, ?, ?, ?)').run(name, email, phone, purpose, message);
  res.status(201).json({ inquiryId: result.lastInsertRowid });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  res.json({ orders: db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all() });
});

app.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const allowed = ['new', 'accepted', 'preparing', 'ready', 'completed', 'cancelled'];
  const status = cleanText(req.body.status, 30);
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid order status.' });
  if (!db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, Number(req.params.id)).changes) return res.status(404).json({ error: 'Order not found.' });
  res.json({ ok: true });
});

app.get('/api/admin/reservations', requireAdmin, (req, res) => {
  res.json({ reservations: db.prepare('SELECT * FROM reservations ORDER BY reservation_date, reservation_time').all() });
});

app.get('/api/admin/event-inquiries', requireAdmin, (req, res) => {
  res.json({ inquiries: db.prepare('SELECT * FROM event_inquiries ORDER BY created_at DESC').all() });
});

app.patch('/api/admin/reservations/:id', requireAdmin, (req, res) => {
  const allowed = ['pending', 'confirmed', 'rejected', 'cancelled'];
  const status = cleanText(req.body.status, 30);
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid reservation status.' });
  if (!db.prepare('UPDATE reservations SET status = ? WHERE id = ?').run(status, Number(req.params.id)).changes) return res.status(404).json({ error: 'Reservation not found.' });
  res.json({ ok: true });
});

app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin.html', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
// Public assets live beside the server and database, so use an explicit allowlist.
const publicFiles = new Set([
  'index.html', 'menu.html', 'reservation.html', 'checkout.html', 'contactus.html',
  'event.html', 'aboutus.html', 'style.css', 'site.js', 'menu-runtime.js',
  'availability-runtime.js', 'admin.js'
]);
const publicAssetPrefixes = ['/icons/', '/menu/', '/events/', '/backgroundpics/'];
app.use((req, res, next) => {
  const isPublicFile = req.path === '/' || publicFiles.has(req.path.slice(1));
  const isPublicAsset = publicAssetPrefixes.some(prefix => req.path.startsWith(prefix));
  if (!isPublicFile && !isPublicAsset) return res.status(404).json({ error: 'Not found.' });
  next();
});
app.use(express.static(__dirname, { extensions: ['html'], dotfiles: 'deny', index: 'index.html' }));

app.use((error, req, res, next) => {
  console.error('Unhandled request error:', error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Something went wrong. Please try again later.' });
});

app.listen(port, () => console.log(`MamanPaz server running at http://localhost:${port}`));
