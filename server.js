require('dotenv').config();
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const Database = require('better-sqlite3');
const mailer = require('./mailer');
const { hashPassword, verifyPassword } = require('./staff-auth');

const app = express();
const port = Number(process.env.PORT || 3000);
const uploadRoot = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
const orderingTestMode = process.env.NODE_ENV !== 'production' && process.env.ORDER_TEST_MODE === 'true';
const productionDatabasePath = path.resolve(process.env.DB_PATH || path.join(__dirname, 'mamanpaz.sqlite'));
const testDatabasePath = path.resolve(process.env.ORDER_TEST_DB_PATH || path.join(path.dirname(productionDatabasePath), `${path.basename(productionDatabasePath, path.extname(productionDatabasePath))}-test${path.extname(productionDatabasePath) || '.sqlite'}`));
if (orderingTestMode && testDatabasePath === productionDatabasePath) {
  throw new Error('ORDER_TEST_DB_PATH must point to a separate database from DB_PATH.');
}
const databasePath = orderingTestMode ? testDatabasePath : productionDatabasePath;

function ensureWritableDirectory(directory, description) {
  let probeDirectory;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    probeDirectory = fs.mkdtempSync(path.join(directory, '.mamanpaz-write-check-'));
    fs.rmdirSync(probeDirectory);
  } catch (error) {
    if (probeDirectory && fs.existsSync(probeDirectory)) {
      try { fs.rmdirSync(probeDirectory); } catch (cleanupError) {
        console.error(`Could not remove temporary ${description} check directory "${probeDirectory}":`, cleanupError.message);
      }
    }
    throw new Error(`Cannot access writable ${description} directory "${directory}": ${error.message}`, { cause: error });
  }
}

const databaseDirectory = path.dirname(databasePath);
ensureWritableDirectory(databaseDirectory, 'database');
ensureWritableDirectory(uploadRoot, 'upload');
if (fs.existsSync(databasePath)) {
  try {
    if (!fs.statSync(databasePath).isFile()) throw new Error('The configured database path is not a regular file.');
    fs.accessSync(databasePath, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    throw new Error(`Cannot access existing SQLite database "${databasePath}": ${error.message}`, { cause: error });
  }
}

let db;
try {
  db = new Database(databasePath);
} catch (error) {
  throw new Error(`Cannot open SQLite database "${databasePath}": ${error.message}`, { cause: error });
}
const sessions = new Map();
const sessionMaxAge = 1000 * 60 * 60 * 8;
const menuCategories = ['kebab', 'stews', 'rice', 'side', 'starters', 'wraps', 'desserts', 'drinks', 'sauces'];
const businessTimeZone = 'Europe/Amsterdam';
const defaultDeliveryPostcodes = [
  ...['6211', '6212', '6213', '6214', '6215', '6216', '6217', '6218', '6219', '6221', '6222', '6223', '6224', '6225', '6226', '6227', '6228', '6229', '6231', '6235', '6237', '6241', '6243', '6245', '6247', '6251', '6252', '6267', '6268', '6325']
    .map(postcode => ({ country: 'Netherlands', postcode })),
  ...['3620', '3621', '3630', '3631', '3740', '3742', '3746', '3770', '4600', '4690']
    .map(postcode => ({ country: 'Belgium', postcode }))
];
const wrapSaucePriceCents = 50;
const orderSlotMinutes = 15;
const orderScheduleDays = 21;
const deliveryLeadMinutes = 30;
const configuredCollectionPrep = Number(process.env.ORDER_COLLECTION_PREP_MINUTES);
const collectionPrepMinutes = Number.isInteger(configuredCollectionPrep) ? Math.max(0, Math.min(180, configuredCollectionPrep)) : 30;
// Closed-hours ordering is never enabled in production, even if a host is
// accidentally configured with ORDER_TEST_MODE=true.
const testCollectionPrepMinutes = Number.isInteger(Number(process.env.ORDER_TEST_COLLECTION_LEAD_MINUTES))
  ? Math.max(0, Math.min(180, Number(process.env.ORDER_TEST_COLLECTION_LEAD_MINUTES))) : 15;
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const defaultHours = Object.fromEntries(weekdays.map(day => [day, {
  open: !['monday', 'tuesday'].includes(day),
  opens: '16:30', closes: '22:00',
  orders: !['monday', 'tuesday'].includes(day),
  reservations: !['monday', 'tuesday'].includes(day)
}]));
const initialDishDays = new Map([
  [/fesenjoon/i, { days: ['wednesday'], description: 'Zoetzure saus van gemalen walnoten en granaatappelmelasse met gehaktballen, geserveerd met gewone en saffraanrijst.' }],
  [/adas polo/i, { days: ['thursday'], description: 'Gewone en saffraanrijst gemengd met linzen, gehakt, rozijnen en gebakken ui.' }],
  [/baghali polo ba (gosht|goosht)/i, { days: ['friday'], description: 'Rijst gemengd met tuinbonen en kruiden, met stukjes langzaam gestoofd kalfsvlees.' }],
  [/loobia polo/i, { days: ['saturday'], description: 'Rijst met bonen, tomatenpuree en kruiden, met stukjes kalfsvlees.' }],
  [/zereshk.?polo ba morgh/i, { days: ['sunday'], description: 'Gewone en saffraanrijst met berberis, geserveerd met een kippenbout gestoofd in saffraan en tomatensaus.' }]
]);

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: false }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

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

function normalizedDeliveryCountry(value) {
  const country = cleanText(value, 80).toLowerCase();
  if (country === 'netherlands') return 'Netherlands';
  if (country === 'belgium') return 'Belgium';
  return '';
}

function normalizedPostcode(value, country) {
  const postcode = cleanText(value, 16).toUpperCase().replace(/\s+/g, ' ');
  if (country === 'Netherlands') {
    const match = /^(\d{4})\s?([A-Z]{2})$/.exec(postcode);
    return match ? `${match[1]} ${match[2]}` : '';
  }
  if (country === 'Belgium') return /^\d{4}$/.test(postcode) ? postcode : '';
  return '';
}

function normalizedApprovedPostcode(value, country) {
  const postcode = cleanText(value, 16).toUpperCase().replace(/\s+/g, ' ');
  if (country === 'Netherlands' && /^\d{4}$/.test(postcode)) return postcode;
  return normalizedPostcode(postcode, country);
}

function deliveryPostcodeIsApproved(postcodes, country, postcode) {
  return postcodes.some(entry => entry.country === country && (
    country === 'Netherlands' && /^\d{4}$/.test(entry.postcode)
      ? postcode.startsWith(entry.postcode)
      : entry.postcode === postcode
  ));
}

function normalizedDeliveryAddress(address) {
  const country = normalizedDeliveryCountry(address.country);
  return {
    street: cleanText(address.street, 120),
    houseNumber: cleanText(address.houseNumber, 20),
    addition: cleanText(address.addition, 40),
    postcode: normalizedPostcode(address.postcode, country) || cleanText(address.postcode, 16).toUpperCase().replace(/\s+/g, ' '),
    city: cleanText(address.city, 100),
    country
  };
}

function validDeliveryAddress(address) {
  return address.street.length >= 2
    && /^[\p{L}\p{N}][\p{L}\p{N} ./'’#-]{0,19}$/u.test(address.houseNumber)
    && Boolean(normalizedPostcode(address.postcode, address.country))
    && address.city.length >= 2
    && Boolean(address.country);
}

function approvedDeliveryPostcodes() {
  const setting = db.prepare('SELECT value FROM restaurant_settings WHERE key = ?').get('delivery_postcodes');
  if (!setting) return defaultDeliveryPostcodes;
  const saved = JSON.parse(setting.value);
  if (!Array.isArray(saved)) throw new Error('Stored delivery postcode configuration is invalid.');
  return saved.map(entry => {
    const country = normalizedDeliveryCountry(entry?.country);
    const postcode = normalizedApprovedPostcode(entry?.postcode, country);
    if (!country || !postcode) throw new Error('Stored delivery postcode configuration is invalid.');
    return { country, postcode };
  });
}

function saveApprovedDeliveryPostcodes(postcodes) {
  db.prepare('INSERT INTO restaurant_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('delivery_postcodes', JSON.stringify(postcodes));
}

function parsePrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0 || price > 10000) return null;
  return Math.round(price * 100) / 100;
}

function safeMenuImage(value) {
  const image = cleanText(value, 300);
  return !image || (/^(?:menu\/[\w./-]+|\/uploads\/menu\/[a-f\d]{32}\.(?:png|jpg|webp|gif))$/i.test(image) && !image.includes('..')) ? image : null;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validPhone(value) {
  return /^[0-9+()\s-]{6,40}$/.test(value);
}

function addCustomerHistoryLabels(orders, reservations) {
  const normalizeName = value => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  const normalizePhone = value => {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('0')) digits = `31${digits.slice(1)}`;
    return digits;
  };
  const records = [
    ...orders.map(record => ({ ...record, record_kind: 'order' })),
    ...reservations.map(record => ({ ...record, record_kind: 'reservation' }))
  ].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.record_kind.localeCompare(b.record_kind) || a.id - b.id);
  const namesByPhone = new Map();
  for (const record of records) {
    const phone = normalizePhone(record.phone);
    const name = normalizeName(record.customer_name || record.name);
    if (!phone || !name) {
      record.customer_type = 'unknown';
      continue;
    }
    const previousNames = namesByPhone.get(phone);
    record.customer_type = !previousNames ? 'first-time' : previousNames.has(name) ? 'returning' : 'unknown';
    if (!previousNames) namesByPhone.set(phone, new Set([name]));
    else previousNames.add(name);
  }
  const newestFirst = (a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id;
  return {
    orders: records.filter(record => record.record_kind === 'order').sort(newestFirst).map(({ record_kind, ...record }) => record),
    reservations: records.filter(record => record.record_kind === 'reservation').sort(newestFirst).map(({ record_kind, ...record }) => record)
  };
}

function validFutureDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== value) return false;
  return value >= zonedParts().date;
}

function validOrderDate(value) {
  return validFutureDate(value) && value <= addLocalDays(zonedParts().date, orderScheduleDays - 1);
}

function zonedParts(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: businessTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday.toLowerCase(), time: `${parts.hour}:${parts.minute}` };
}

function weekdayForDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return weekdays[new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()];
}

function currentBusinessHours() {
  const row = db.prepare('SELECT value FROM restaurant_settings WHERE key = ?').get('business_hours');
  if (!row) return defaultHours;
  try { return { ...defaultHours, ...JSON.parse(row.value) }; } catch { return defaultHours; }
}

function serviceIsOpen(service, dateTime = new Date()) {
  const local = zonedParts(dateTime);
  const day = currentBusinessHours()[local.weekday];
  return Boolean(day?.open && day?.[service] && local.time >= day.opens && local.time < day.closes);
}

function serviceEnabledToday(service) {
  const local = zonedParts();
  const day = currentBusinessHours()[local.weekday];
  return Boolean(day?.open && day?.[service]);
}

function dateServiceIsOpen(service, date, time) {
  const day = currentBusinessHours()[weekdayForDate(date)];
  return Boolean(day?.open && day?.[service] && time >= day.opens && time < day.closes);
}

function addLocalDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days, 12));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function localDateTimeCandidates(date, time) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const sample = new Date(localAsUtc + hours * 60 * 60 * 1000);
    const p = zonedParts(sample);
    const [sampleYear, sampleMonth, sampleDay] = p.date.split('-').map(Number);
    const localSampleAsUtc = Date.UTC(sampleYear, sampleMonth - 1, sampleDay, Number(p.time.slice(0, 2)), Number(p.time.slice(3, 5)));
    offsets.add((localSampleAsUtc - Math.floor(sample.getTime() / 60000) * 60000) / 60000);
  }
  return [...offsets].map(offset => new Date(localAsUtc - offset * 60000)).filter(candidate => {
    const parts = zonedParts(candidate);
    return parts.date === date && parts.time === time;
  }).sort((a, b) => a - b);
}

function getAvailableOrderSlots(type, now = new Date()) {
  const current = zonedParts(now);
  const hours = currentBusinessHours();
  const deliverySetting = db.prepare('SELECT value FROM restaurant_settings WHERE key = ?').get('delivery');
  const deliveryEnabled = !deliverySetting || deliverySetting.value !== 'closed';
  if (orderingTestMode) {
    const leadMinutes = type === 'delivery' ? deliveryLeadMinutes : testCollectionPrepMinutes;
    const earliest = now.getTime() + leadMinutes * 60000;
    const slots = [];
    const seenSlots = new Set();
    const firstInstant = Math.ceil(earliest / (orderSlotMinutes * 60000)) * orderSlotMinutes * 60000;
    const lastDate = addLocalDays(current.date, orderScheduleDays);
    for (let timestamp = firstInstant; ; timestamp += orderSlotMinutes * 60000) {
      const instant = new Date(timestamp);
      const local = zonedParts(instant);
      if (local.date >= lastDate) break;
      const key = `${local.date}|${local.time}`;
      if (!seenSlots.has(key)) {
        seenSlots.add(key);
        slots.push({ date: local.date, time: local.time, instant: instant.toISOString() });
      }
    }
    return { slots, asap: type === 'delivery' && slots.length > 0, testMode: true, today: current.date, timezone: businessTimeZone, serverNow: now.toISOString(), leadMinutes };
  }
  const leadMinutes = type === 'delivery' ? deliveryLeadMinutes : collectionPrepMinutes;
  if (type === 'delivery' && !deliveryEnabled) {
    return { slots: [], asap: false, testMode: false, today: current.date, timezone: businessTimeZone, serverNow: now.toISOString(), leadMinutes };
  }
  const orderingOpenNow = serviceIsOpen('orders', now);
  const asap = orderingOpenNow && (type === 'delivery' || leadMinutes === 0);
  const earliest = now.getTime() + leadMinutes * 60000;
  const slots = [];
  for (let offset = 0; offset < orderScheduleDays; offset++) {
    const date = addLocalDays(current.date, offset);
    const day = hours[weekdayForDate(date)];
    if (!day?.open || !day.orders || (type === 'delivery' && !deliveryEnabled)) continue;
    const [openHour, openMinute] = day.opens.split(':').map(Number);
    const [closeHour, closeMinute] = day.closes.split(':').map(Number);
    const opening = openHour * 60 + openMinute;
    const closing = closeHour * 60 + closeMinute;
    const first = Math.ceil(opening / orderSlotMinutes) * orderSlotMinutes;
    for (let minutes = first; minutes < closing; minutes += orderSlotMinutes) {
      const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      const instant = localDateTimeCandidates(date, time).find(candidate => candidate.getTime() >= earliest);
      if (instant) slots.push({ date, time, instant: instant.toISOString() });
    }
  }
  return { slots, asap: asap && slots.length > 0, testMode: false, today: current.date, timezone: businessTimeZone, serverNow: now.toISOString(), leadMinutes };
}

function allowedMenuDays(raw) {
  try { const values = JSON.parse(raw || '[]'); return Array.isArray(values) ? values : []; } catch { return []; }
}

function menuDescriptionForSchedule(name, description, days) {
  if (![...initialDishDays.keys()].some(pattern => pattern.test(name))) return description;
  const clean = description.replace(/^Alleen verkrijgbaar op [^.]+\.\s*/i, '').replace(/^Alleen op [^!]+!\s*/i, '').trim();
  if (!days.length) return clean;
  const dutch = { monday: 'maandag', tuesday: 'dinsdag', wednesday: 'woensdag', thursday: 'donderdag', friday: 'vrijdag', saturday: 'zaterdag', sunday: 'zondag' };
  return `Alleen verkrijgbaar op ${days.map(day => dutch[day]).join(' en ')}. ${clean}`;
}

function menuItemAvailable(item, date = zonedParts().date) {
  const days = allowedMenuDays(item.available_days);
  return Boolean(item.available && (!days.length || days.includes(weekdayForDate(date))));
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
    name_fa TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    category TEXT NOT NULL,
    image TEXT NOT NULL DEFAULT '',
    available INTEGER NOT NULL DEFAULT 1,
    available_days TEXT NOT NULL DEFAULT '[]',
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
    street TEXT NOT NULL DEFAULT '',
    house_number TEXT NOT NULL DEFAULT '',
    address_addition TEXT NOT NULL DEFAULT '',
    postcode TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    delivery_instructions TEXT NOT NULL DEFAULT '',
    test_mode INTEGER NOT NULL DEFAULT 0,
    items_json TEXT NOT NULL,
    total_cents INTEGER NOT NULL,
    order_time TEXT NOT NULL DEFAULT 'asap',
    order_date TEXT NOT NULL DEFAULT '',
    payment_method TEXT NOT NULL DEFAULT 'cash',
    status TEXT NOT NULL DEFAULT 'new',
    rejection_reason TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    client_request_id TEXT UNIQUE,
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
    rejection_reason TEXT NOT NULL DEFAULT '',
    client_request_id TEXT UNIQUE,
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
  CREATE TABLE IF NOT EXISTS notification_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT NOT NULL UNIQUE,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    calendar TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TEXT
  );
  CREATE TABLE IF NOT EXISTS test_notification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    event_key TEXT NOT NULL,
    intended_recipient TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Additive migration for databases created before checkout time/payment were saved.
const orderColumns = new Set(db.prepare('PRAGMA table_info(orders)').all().map(column => column.name));
if (!orderColumns.has('order_time')) db.exec("ALTER TABLE orders ADD COLUMN order_time TEXT NOT NULL DEFAULT 'asap'");
if (!orderColumns.has('order_date')) db.exec("ALTER TABLE orders ADD COLUMN order_date TEXT NOT NULL DEFAULT ''");
if (!orderColumns.has('payment_method')) db.exec("ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'cash'");
if (!orderColumns.has('rejection_reason')) db.exec("ALTER TABLE orders ADD COLUMN rejection_reason TEXT NOT NULL DEFAULT ''");
if (!orderColumns.has('client_request_id')) db.exec('ALTER TABLE orders ADD COLUMN client_request_id TEXT');
for (const [column, definition] of Object.entries({
  street: "TEXT NOT NULL DEFAULT ''", house_number: "TEXT NOT NULL DEFAULT ''", address_addition: "TEXT NOT NULL DEFAULT ''",
  postcode: "TEXT NOT NULL DEFAULT ''", city: "TEXT NOT NULL DEFAULT ''", country: "TEXT NOT NULL DEFAULT ''",
  delivery_instructions: "TEXT NOT NULL DEFAULT ''", test_mode: 'INTEGER NOT NULL DEFAULT 0'
})) if (!orderColumns.has(column)) db.exec(`ALTER TABLE orders ADD COLUMN ${column} ${definition}`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS orders_client_request_id_unique ON orders(client_request_id)');
db.exec('CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at DESC)');
const menuColumns = new Set(db.prepare('PRAGMA table_info(menu_items)').all().map(column => column.name));
if (!menuColumns.has('available_days')) db.exec("ALTER TABLE menu_items ADD COLUMN available_days TEXT NOT NULL DEFAULT '[]'");
if (!menuColumns.has('name_fa')) db.exec("ALTER TABLE menu_items ADD COLUMN name_fa TEXT NOT NULL DEFAULT ''");
const reservationColumns = new Set(db.prepare('PRAGMA table_info(reservations)').all().map(column => column.name));
if (!reservationColumns.has('rejection_reason')) db.exec("ALTER TABLE reservations ADD COLUMN rejection_reason TEXT NOT NULL DEFAULT ''");
if (!reservationColumns.has('client_request_id')) db.exec('ALTER TABLE reservations ADD COLUMN client_request_id TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS reservations_client_request_id_unique ON reservations(client_request_id)');
db.exec('CREATE INDEX IF NOT EXISTS reservations_slot_idx ON reservations(reservation_date, reservation_time)');
db.exec('CREATE INDEX IF NOT EXISTS event_inquiries_created_at_idx ON event_inquiries(created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx ON notification_outbox(status, next_attempt_at, id)');
db.prepare('INSERT OR IGNORE INTO restaurant_settings (key, value) VALUES (?, ?)').run('business_hours', JSON.stringify(defaultHours));

let flushingEmailQueue = false;
const restaurantEmail = process.env.RESTAURANT_EMAIL || 'mamanpazmaastricht@gmail.com';
function queueEmail(eventKey, recipient, subject, body, calendar = '') {
  if (!recipient) return;
  db.prepare('INSERT OR IGNORE INTO notification_outbox (event_key, recipient, subject, body, calendar) VALUES (?, ?, ?, ?, ?)').run(eventKey, recipient, subject, body, calendar);
}

async function flushEmailQueue() {
  if (orderingTestMode || flushingEmailQueue || !mailer.configured()) return;
  flushingEmailQueue = true;
  try {
    const messages = db.prepare("SELECT * FROM notification_outbox WHERE status IN ('pending', 'failed') AND attempts < 10 AND next_attempt_at <= CURRENT_TIMESTAMP ORDER BY id LIMIT 10").all();
    for (const message of messages) {
      db.prepare("UPDATE notification_outbox SET status = 'sending' WHERE id = ?").run(message.id);
      try {
        await mailer.sendSmtp({ to: message.recipient, subject: message.subject, text: message.body, calendar: message.calendar || undefined });
        db.prepare("UPDATE notification_outbox SET status = 'sent', sent_at = CURRENT_TIMESTAMP, last_error = '' WHERE id = ?").run(message.id);
      } catch (error) {
        const attempts = message.attempts + 1;
        const waitMinutes = Math.min(60, 2 ** Math.min(attempts, 6));
        const detail = String(error?.message || 'Unknown SMTP error').replace(/[\r\n\t]+/g, ' ').slice(0, 300);
        db.prepare("UPDATE notification_outbox SET status = 'failed', attempts = ?, last_error = ?, next_attempt_at = datetime('now', ?) WHERE id = ?").run(attempts, `SMTP error: ${detail}`, `+${waitMinutes} minutes`, message.id);
        console.error(`Email delivery failed for outbox entry ${message.id}: ${detail}`);
      }
    }
  } finally { flushingEmailQueue = false; }
}

function reportEmailQueueFailure(error) {
  console.error('Email queue flush failed:', error?.message || error);
}

function scheduleEmailFlush() { setImmediate(() => flushEmailQueue().catch(reportEmailQueueFailure)); }

function orderEmailDetails(order) {
  const lines = JSON.parse(order.items_json || '[]').map(item => {
    const sauces = Array.isArray(item.sauces) ? item.sauces.map(sauce => sauce.name) : item.sauce ? [item.sauce.name] : [];
    const extras = [sauces.length ? `with ${sauces.join(' and ')}` : '', item.breadQuantity ? `${item.breadQuantity} extra bread` : ''].filter(Boolean).join(' · ');
    const lineTotal = (item.priceCents * item.quantity + (Number(item.breadQuantity) || 0) * 100) / 100;
    return `${item.quantity} × ${item.name}${extras ? ` (${extras})` : ''} — €${lineTotal.toFixed(2)}`;
  });
  const orderDate = order.order_date && order.order_date !== zonedParts().date ? `${order.order_date} ` : '';
  return [
    'ORDER SUMMARY',
    ...lines,
    '',
    `Service: ${order.type === 'delivery' ? 'Delivery' : 'Collection'}`,
    ...(order.type === 'delivery' && order.address ? [`Delivery address: ${order.address}`] : []),
    ...(order.type === 'delivery' && order.delivery_instructions ? [`Delivery instructions: ${order.delivery_instructions}`] : []),
    `Requested time: ${orderDate}${order.order_time}`,
    `Payment method: ${order.payment_method === 'tikkie' ? 'Tikkie' : 'Cash'}`,
    ...(order.notes ? [`Order notes: ${order.notes}`] : []),
    `Total: €${(order.total_cents / 100).toFixed(2)}`
  ].join('\n');
}

function queueOrderEmails(orderId, outcome = 'received', reason = '') {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return;
  const subjectPrefix = outcome === 'received' ? 'Order received' : outcome === 'accepted' ? 'Order accepted' : outcome === 'rejected' ? 'Order update' : `Order ${outcome}`;
  const detail = orderEmailDetails(order);
  const intro = outcome === 'received'
    ? 'Thank you for placing an order with Mamanpaz Maastricht. We have received your order and our team will confirm it shortly.'
    : outcome === 'accepted'
      ? 'Good news: our team has accepted your order. We look forward to preparing it for you.'
      : outcome === 'rejected'
        ? `We are sorry, but we cannot accept your order.${reason ? `\n\nReason: ${reason}` : '\n\nPlease contact the restaurant if you need more information.'}`
        : `Your order status has been updated to: ${outcome}.`;
  const body = `${intro}\n\nOrder #${order.id}\n\n${detail}\n\nKind regards,\nMamanpaz Maastricht`;
  const eventKey = `order-${order.id}-${outcome}`;
  if (order.test_mode) {
    const record = db.prepare('INSERT OR IGNORE INTO test_notification_log (order_id, event_key, intended_recipient, subject, body) VALUES (?, ?, ?, ?, ?)');
    if (outcome === 'received') record.run(order.id, `${eventKey}-restaurant`, restaurantEmail, `New order to confirm · #${order.id}`, `A new TEST order is waiting for staff confirmation.\n\nCustomer: ${order.customer_name}\nPhone: ${order.phone}\nEmail: ${order.email}\n\n${detail}`);
    if (order.email) record.run(order.id, `${eventKey}-customer`, order.email, `${subjectPrefix} · #${order.id}`, body);
    else if (outcome !== 'received') record.run(order.id, eventKey, '', `${subjectPrefix} · #${order.id}`, body);
    return;
  }
  if (outcome === 'received') queueEmail(`${eventKey}-restaurant`, restaurantEmail, `New order to confirm · #${order.id}`, `A new order is waiting for staff confirmation.\n\nCustomer: ${order.customer_name}\nPhone: ${order.phone}\nEmail: ${order.email}\n\n${detail}`);
  if (order.email) queueEmail(`${eventKey}-customer`, order.email, `${subjectPrefix} · #${order.id}`, body);
}

function queueReservationEmails(id, outcome = 'received', reason = '', previouslyConfirmed = false) {
  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
  if (!reservation) return;
  const details = [
    `Reservation #${reservation.id}`,
    `Name: ${reservation.name}`,
    `Date: ${reservation.reservation_date}`,
    `Time: ${reservation.reservation_time}`,
    `Guests: ${reservation.guests}`,
    `Phone: ${reservation.phone}`,
    `Email: ${reservation.email}`,
    ...(reservation.purpose ? [`Occasion: ${reservation.purpose}`] : []),
    ...(reservation.notes ? [`Notes: ${reservation.notes}`] : [])
  ].join('\n');
  const eventKey = `reservation-${reservation.id}-${outcome}`;
  if (outcome === 'received') {
    queueEmail(`${eventKey}-restaurant`, restaurantEmail, `Reservation request to review · #${reservation.id}`, `A new reservation request is waiting for staff review.\n\n${details}`);
    queueEmail(`${eventKey}-customer`, reservation.email, `We received your reservation request · #${reservation.id}`, `Thank you for choosing Mamanpaz Maastricht. We have received your request. It is not confirmed yet; our team will contact you after reviewing it.\n\n${details}\n\nKind regards,\nMamanpaz Maastricht`);
  } else if (outcome === 'confirmed') {
    queueEmail(`${eventKey}-customer`, reservation.email, `Your reservation is confirmed · #${reservation.id}`, `Your reservation at Mamanpaz Maastricht is confirmed. We look forward to welcoming you.\n\n${details}\n\nKind regards,\nMamanpaz Maastricht`, mailer.createCalendarInvite(reservation));
  } else if (outcome === 'rejected') {
    queueEmail(`${eventKey}-customer`, reservation.email, `Reservation request update · #${reservation.id}`, `We are sorry, but we cannot confirm your reservation request.${reason ? `\n\nReason: ${reason}` : '\n\nPlease contact us if you would like to discuss another time.'}\n\n${details}\n\nKind regards,\nMamanpaz Maastricht`);
  } else if (outcome === 'cancelled') {
    queueEmail(`${eventKey}-customer`, reservation.email, `Reservation cancelled · #${reservation.id}`, `Your reservation at Mamanpaz Maastricht has been cancelled.${reason ? `\n\nReason: ${reason}` : ''}\n\n${details}\n\nKind regards,\nMamanpaz Maastricht`, previouslyConfirmed ? mailer.createCalendarInvite(reservation, 'CANCEL') : '');
  }
}

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

// The menu's sauce prices were used as wrap add-on prices; normalize only the
// sauce category once, leaving unrelated menu items and historical orders intact.
if (!db.prepare('SELECT 1 FROM restaurant_settings WHERE key = ?').get('wrap_sauce_price_v1_initialized')) {
  db.prepare("UPDATE menu_items SET price_cents = 50, updated_at = CURRENT_TIMESTAMP WHERE category = 'sauces'").run();
  db.prepare('INSERT INTO restaurant_settings (key, value) VALUES (?, ?)').run('wrap_sauce_price_v1_initialized', 'yes');
}

// Initialize the weekly schedules and Persian names only after the initial menu seed.
if (!db.prepare('SELECT 1 FROM restaurant_settings WHERE key = ?').get('dish_schedule_v2_initialized')) {
  const initialDayUpdate = db.prepare('UPDATE menu_items SET available_days = ?, description = ? WHERE id = ?');
  for (const item of db.prepare('SELECT id, name, description, available_days FROM menu_items').all()) {
    const rule = [...initialDishDays].find(([pattern]) => pattern.test(item.name));
    if (!rule) continue;
    const { days: [day], description } = rule[1];
    const dayName = { wednesday: 'woensdag', thursday: 'donderdag', friday: 'vrijdag', saturday: 'zaterdag', sunday: 'zondag' }[day];
    const currentDescription = item.description.replace(/^Alleen verkrijgbaar op [^.]+\.\s*/i, '').replace(/^Alleen op [^!]+!\s*/i, '').trim();
    const cleanDescription = currentDescription && !/^Alleen verkrijgbaar op/i.test(item.description) ? currentDescription : description;
    initialDayUpdate.run(JSON.stringify([day]), `Alleen verkrijgbaar op ${dayName}. ${cleanDescription}`, item.id);
  }
  db.prepare('INSERT INTO restaurant_settings (key, value) VALUES (?, ?)').run('dish_schedule_v2_initialized', 'yes');
}
if (!db.prepare('SELECT 1 FROM restaurant_settings WHERE key = ?').get('dish_schedule_v3_initialized')) {
  const updateSchedule = db.prepare('UPDATE menu_items SET available_days = ?, description = ? WHERE id = ?');
  for (const item of db.prepare('SELECT id, name, description FROM menu_items').all()) {
    const rule = [...initialDishDays].find(([pattern]) => pattern.test(item.name));
    if (!rule) continue;
    const { days } = rule[1];
    updateSchedule.run(JSON.stringify(days), menuDescriptionForSchedule(item.name, item.description, days), item.id);
  }
  db.prepare('INSERT INTO restaurant_settings (key, value) VALUES (?, ?)').run('dish_schedule_v3_initialized', 'yes');
}
if (!db.prepare('SELECT 1 FROM restaurant_settings WHERE key = ?').get('dish_schedule_v4_initialized')) {
  const items = db.prepare("SELECT id, name, description FROM menu_items WHERE lower(name) LIKE 'baghali polo ba %'").all();
  for (const item of items) {
    const description = menuDescriptionForSchedule(item.name, item.description, ['saturday']);
    db.prepare('UPDATE menu_items SET available_days = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(['saturday']), description, item.id);
  }
  db.prepare('INSERT INTO restaurant_settings (key, value) VALUES (?, ?)').run('dish_schedule_v4_initialized', 'yes');
}
if (!db.prepare('SELECT 1 FROM restaurant_settings WHERE key = ?').get('dish_schedule_v5_initialized')) {
  const items = db.prepare("SELECT id, name, description FROM menu_items WHERE lower(name) LIKE 'baghali polo ba %'").all();
  for (const item of items) {
    const description = menuDescriptionForSchedule(item.name, item.description, ['friday']);
    db.prepare('UPDATE menu_items SET available_days = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(['friday']), description, item.id);
  }
  db.prepare('INSERT INTO restaurant_settings (key, value) VALUES (?, ?)').run('dish_schedule_v5_initialized', 'yes');
}
if (!db.prepare('SELECT 1 FROM restaurant_settings WHERE key = ?').get('menu_translation_v2_initialized')) {
  const source = fs.readFileSync(path.join(__dirname, 'menu.html'), 'utf8');
  const translate = db.prepare('UPDATE menu_items SET name_fa = ? WHERE lower(name) = lower(?) AND name_fa = ?');
  for (const match of source.matchAll(/<span class="item-en">([^<]+)<\/span>[\s\S]*?<span class="item-fa">([^<]+)<\/span>/g)) translate.run(match[2].trim(), match[1].trim(), '');
  db.prepare('INSERT INTO restaurant_settings (key, value) VALUES (?, ?)').run('menu_translation_v2_initialized', 'yes');
}

const staffCount = db.prepare('SELECT COUNT(*) AS count FROM staff_users').get().count;
if (staffCount === 0) {
  const initialUsername = cleanText(process.env.ADMIN_USERNAME, 100);
  const initialPassword = process.env.ADMIN_PASSWORD || '';
  if (!initialUsername || !initialPassword) {
    if (process.env.NODE_ENV === 'production') throw new Error('Production startup requires ADMIN_USERNAME and ADMIN_PASSWORD to create the initial staff account.');
    console.warn('No staff account exists. Create a .env file with ADMIN_USERNAME and ADMIN_PASSWORD, then restart the server.');
  } else if (initialPassword.length < 16) {
    if (process.env.NODE_ENV === 'production') throw new Error('The initial production staff password must contain at least 16 characters.');
    console.warn('No staff account was created. Set ADMIN_PASSWORD to at least 16 characters, then restart the server.');
  } else {
    db.prepare('INSERT INTO staff_users (username, password_hash, role) VALUES (?, ?, ?)').run(
      initialUsername,
      hashPassword(initialPassword),
      'admin'
    );
    console.log('Created initial staff account.');
  }
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
  const items = db.prepare('SELECT id, name, name_fa, description, price_cents, category, image, available, available_days, sort_order FROM menu_items ORDER BY category, sort_order, id').all()
    .map(item => {
      const menuImage = /^menu\/(?:optimized\/)?([\w.-]+)\.(?:png|jpe?g)$/i.exec(item.image);
      if (menuImage) {
        const optimized = `menu/optimized/${menuImage[1]}.png`;
        if (fs.existsSync(path.join(__dirname, optimized))) item.image = optimized;
      }
      return item;
    });
  res.set('Cache-Control', 'no-cache');
  res.json({ items, today: zonedParts().weekday, wrapSaucePriceCents });
});

app.get('/api/admin/menu', requireAdmin, (req, res) => {
  res.json({ items: db.prepare('SELECT * FROM menu_items ORDER BY category, sort_order, id').all() });
});

app.get('/api/settings/business-hours', (req, res) => {
  const local = zonedParts();
  res.json({ timezone: businessTimeZone, hours: currentBusinessHours(), today: local.weekday, todayDate: local.date, openNow: serviceIsOpen('orders') });
});

app.get('/api/order-slots', (req, res) => {
  const type = req.query.type;
  if (!['delivery', 'pickup'].includes(type)) return res.status(400).json({ error: 'Choose delivery or pickup to check available times.' });
  const result = getAvailableOrderSlots(type);
  if (process.env.NODE_ENV !== 'production') {
    console.info(`[order-slots] type=${type} slots=${result.slots.length} asap=${result.asap} testMode=${result.testMode} timezone=${result.timezone}`);
  }
  res.json(result);
});

app.get('/api/settings/order-mode', (_req, res) => {
  res.json({ testMode: orderingTestMode, timezone: businessTimeZone });
});

app.patch('/api/admin/settings/business-hours', requireAdmin, (req, res) => {
  const hours = req.body.hours;
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!hours || weekdays.some(day => !hours[day] || typeof hours[day].open !== 'boolean' || typeof hours[day].orders !== 'boolean' || typeof hours[day].reservations !== 'boolean' || !timePattern.test(hours[day].opens) || !timePattern.test(hours[day].closes) || hours[day].closes <= hours[day].opens)) {
    return res.status(400).json({ error: 'Enter valid opening and closing times and service settings for every day.' });
  }
  db.prepare('INSERT INTO restaurant_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('business_hours', JSON.stringify(hours));
  res.json({ hours });
});

app.post('/api/admin/menu-image', requireAdmin, (req, res) => {
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([a-z\d+/]+=*)$/i.exec(String(req.body.dataUrl || ''));
  if (!match) return res.status(400).json({ error: 'Choose a PNG, JPG, WEBP, or GIF image.' });
  const [, format, encoded] = match;
  const image = Buffer.from(encoded, 'base64');
  if (!image.length || image.length > 4 * 1024 * 1024) return res.status(400).json({ error: 'Images must be smaller than 4 MB.' });
  const signatures = {
    png: image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    jpeg: image[0] === 255 && image[1] === 216 && image[2] === 255,
    gif: ['GIF87a', 'GIF89a'].includes(image.subarray(0, 6).toString()),
    webp: image.subarray(0, 4).toString() === 'RIFF' && image.subarray(8, 12).toString() === 'WEBP'
  };
  if (!signatures[format.toLowerCase()]) return res.status(400).json({ error: 'The selected file is not a valid supported image.' });
  const extension = format.toLowerCase() === 'jpeg' ? 'jpg' : format.toLowerCase();
  const filename = `${crypto.randomBytes(16).toString('hex')}.${extension}`;
  const uploadDirectory = path.join(uploadRoot, 'menu');
  fs.mkdirSync(uploadDirectory, { recursive: true });
  fs.writeFileSync(path.join(uploadDirectory, filename), image, { flag: 'wx' });
  res.status(201).json({ image: `/uploads/menu/${filename}` });
});

app.post('/api/admin/menu', requireAdmin, (req, res) => {
  const name = cleanText(req.body.name, 120);
  const nameFa = cleanText(req.body.nameFa, 120);
  const baseDescription = cleanText(req.body.description, 1000);
  const category = cleanText(req.body.category, 40);
  const image = safeMenuImage(req.body.image);
  const availableDays = Array.isArray(req.body.availableDays) ? [...new Set(req.body.availableDays)] : [];
  const price = parsePrice(req.body.price);
  if (!name || !menuCategories.includes(category) || price === null || image === null || availableDays.some(day => !weekdays.includes(day))) return res.status(400).json({ error: 'Name, a supported category, valid price, image, and available days are required.' });
  const description = menuDescriptionForSchedule(name, baseDescription, availableDays);
  const result = db.prepare('INSERT INTO menu_items (name, name_fa, description, price_cents, category, image, available, available_days, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(name, nameFa, description, Math.round(price * 100), category, image, req.body.available === false ? 0 : 1, JSON.stringify(availableDays), Number(req.body.sortOrder) || 0);
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
    nameFa: req.body.nameFa === undefined ? current.name_fa : cleanText(req.body.nameFa, 120),
    description: req.body.description === undefined ? current.description : cleanText(req.body.description, 1000),
    category: req.body.category === undefined ? current.category : cleanText(req.body.category, 40),
    image: req.body.image === undefined ? current.image : safeMenuImage(req.body.image),
    available: req.body.available === undefined ? current.available : (req.body.available ? 1 : 0),
    availableDays: req.body.availableDays === undefined ? allowedMenuDays(current.available_days) : [...new Set(Array.isArray(req.body.availableDays) ? req.body.availableDays : [])],
    sortOrder: req.body.sortOrder === undefined ? current.sort_order : Number(req.body.sortOrder) || 0
  };
  if (!item.name || !menuCategories.includes(item.category) || item.image === null || item.availableDays.some(day => !weekdays.includes(day))) return res.status(400).json({ error: 'Name, supported category, valid image, and available days are required.' });
  if (req.body.availableDays !== undefined || req.body.name !== undefined || req.body.description !== undefined) item.description = menuDescriptionForSchedule(item.name, item.description, item.availableDays);
  db.prepare('UPDATE menu_items SET name = ?, name_fa = ?, description = ?, price_cents = ?, category = ?, image = ?, available = ?, available_days = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(item.name, item.nameFa, item.description, Math.round(price * 100), item.category, item.image, item.available, JSON.stringify(item.availableDays), item.sortOrder, id);
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

app.get('/api/admin/delivery-postcodes', requireAdmin, (_req, res) => {
  res.json({ postcodes: approvedDeliveryPostcodes() });
});

app.post('/api/admin/delivery-postcodes', requireAdmin, (req, res) => {
  const country = normalizedDeliveryCountry(req.body.country);
  const postcode = normalizedApprovedPostcode(req.body.postcode, country);
  if (!country || !postcode) return res.status(400).json({ error: 'Enter a valid Netherlands or Belgium postcode.' });
  const postcodes = approvedDeliveryPostcodes();
  if (postcodes.some(entry => entry.country === country && entry.postcode === postcode)) {
    return res.status(200).json({ postcodes, added: false });
  }
  postcodes.push({ country, postcode });
  postcodes.sort((left, right) => left.country.localeCompare(right.country) || left.postcode.localeCompare(right.postcode));
  saveApprovedDeliveryPostcodes(postcodes);
  res.status(201).json({ postcodes, added: true });
});

app.delete('/api/admin/delivery-postcodes', requireAdmin, (req, res) => {
  const country = normalizedDeliveryCountry(req.body.country);
  const postcode = normalizedApprovedPostcode(req.body.postcode, country);
  if (!country || !postcode) return res.status(400).json({ error: 'Select a valid country and postcode to remove.' });
  const postcodes = approvedDeliveryPostcodes();
  const updated = postcodes.filter(entry => entry.country !== country || entry.postcode !== postcode);
  if (updated.length === postcodes.length) return res.status(404).json({ error: 'Approved postcode not found.' });
  saveApprovedDeliveryPostcodes(updated);
  res.json({ postcodes: updated });
});

app.post('/api/delivery/eligibility', rateLimit(30, 15 * 60 * 1000), (req, res) => {
  const country = normalizedDeliveryCountry(req.body.country);
  const postcode = normalizedPostcode(req.body.postcode, country);
  if (!country || !postcode) return res.status(400).json({ error: 'Enter a valid Netherlands or Belgium postcode.' });
  const setting = db.prepare('SELECT value FROM restaurant_settings WHERE key = ?').get('delivery');
  if (setting?.value === 'closed' && !orderingTestMode) {
    return res.json({ available: false, message: 'Delivery is currently unavailable. Please choose takeaway or call the restaurant.' });
  }
  const postcodes = approvedDeliveryPostcodes();
  if (!postcodes.length) {
    return res.json({ available: false, message: 'Delivery is not available yet because no delivery postcodes have been configured.' });
  }
  const available = deliveryPostcodeIsApproved(postcodes, country, postcode);
  res.json({
    available,
    message: available
      ? 'Delivery is available to this postcode. A €3,00 delivery fee applies.'
      : 'Sorry, we do not deliver to this postcode. Please choose takeaway or call the restaurant.'
  });
});

app.post('/api/orders', rateLimit(10, 15 * 60 * 1000), async (req, res) => {
  const customerName = cleanText(req.body.customerName, 120);
  const phone = cleanText(req.body.phone, 40);
  const email = cleanText(req.body.email, 160);
  const type = req.body.type;
  const suppliedAddress = req.body.deliveryAddress && typeof req.body.deliveryAddress === 'object' ? req.body.deliveryAddress : {};
  const verifiedAddress = normalizedDeliveryAddress({ ...suppliedAddress, country: suppliedAddress.country || 'Netherlands' });
  const { street, houseNumber, addition: addressAddition, postcode, city, country } = verifiedAddress;
  const deliveryInstructions = cleanText(suppliedAddress.instructions, 500);
  const address = type === 'delivery' ? [street, `${houseNumber}${addressAddition ? ` ${addressAddition}` : ''}`, `${postcode} ${city}`, country].filter(Boolean).join(', ') : '';
  const notes = cleanText(req.body.notes, 1000);
  let orderTime = cleanText(req.body.orderTime, 20);
  let orderDate = cleanText(req.body.orderDate, 10) || zonedParts().date;
  const paymentMethod = cleanText(req.body.paymentMethod, 20);
  const requestId = cleanText(req.body.requestId, 80);
  const legacyBreadQuantity = Number(req.body.breadQuantity || 0);
  const requestedItems = Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [];
  const validOrderTime = orderTime === 'asap' || (/^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/.test(orderTime));
  if (!customerName || !validPhone(phone) || !validEmail(email) || !requestedItems.length || !validOrderTime || !/^\d{4}-\d{2}-\d{2}$/.test(orderDate) || !['pickup', 'delivery'].includes(type) || !['cash', 'tikkie'].includes(paymentMethod) || !Number.isInteger(legacyBreadQuantity) || legacyBreadQuantity < 0 || legacyBreadQuantity > 30 || !/^[\da-f-]{36}$/i.test(requestId)) return res.status(400).json({ error: 'Enter valid contact, order time, payment, and cart details.' });
  const existingRequest = db.prepare('SELECT id, test_mode FROM orders WHERE client_request_id = ?').get(requestId);
  if (existingRequest) return res.status(200).json({ orderId: existingRequest.id, duplicate: true, testMode: Boolean(existingRequest.test_mode) });
  if (!validOrderDate(orderDate)) return res.status(400).json({ error: 'Choose an order date within the next 21 days.' });
  const itemIds = new Set();
  for (const item of requestedItems) {
    const id = Number(item.id), quantity = Number(item.quantity);
    const sauceIds = Array.isArray(item.sauceIds) ? item.sauceIds.map(Number) : item.sauceId == null ? [] : [Number(item.sauceId)];
    const breadQuantity = item.breadQuantity == null ? 0 : Number(item.breadQuantity);
    if (!Number.isInteger(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 30 || sauceIds.length > 2 || sauceIds.some(sauceId => !Number.isInteger(sauceId)) || new Set(sauceIds).size !== sauceIds.length || !Number.isInteger(breadQuantity) || breadQuantity < 0 || breadQuantity > quantity) return res.status(400).json({ error: 'Your cart contains an invalid quantity or option. A wrap can have up to two different sauces.' });
    item.sauceIds = sauceIds;
    itemIds.add(id); sauceIds.forEach(sauceId => itemIds.add(sauceId));
  }
  if (itemIds.size > 100) return res.status(400).json({ error: 'Your cart contains too many items.' });
  const ids = [...itemIds];
  const placeholders = ids.map(() => '?').join(', ');
  const menuItems = db.prepare(`SELECT id, name, price_cents, category, available, available_days FROM menu_items WHERE id IN (${placeholders})`).all(...ids);
  const byId = new Map(menuItems.map(item => [item.id, item]));
  const today = zonedParts().date;
  const availabilityDate = orderTime === 'asap' ? today : orderDate;
  if (menuItems.length !== ids.length || menuItems.some(item => !menuItemAvailable(item, availabilityDate))) return res.status(409).json({ error: 'One or more items are sold out or not available on the selected order date.' });
  const items = [];
  let breadQuantity = legacyBreadQuantity;
  for (const requested of requestedItems) {
    const base = byId.get(Number(requested.id));
    const sauces = requested.sauceIds.map(sauceId => byId.get(sauceId));
    if (!base || (sauces.length && (base.category !== 'wraps' || sauces.some(sauce => !sauce || sauce.category !== 'sauces')))) return res.status(400).json({ error: 'This wrap sauce selection is not available.' });
    const quantity = Number(requested.quantity);
    const lineBreadQuantity = Number(requested.breadQuantity || 0);
    breadQuantity += lineBreadQuantity;
    items.push({ id: base.id, name: base.name, quantity, basePriceCents: base.price_cents, sauces: sauces.map(sauce => ({ id: sauce.id, name: sauce.name, priceCents: wrapSaucePriceCents })), sauce: sauces[0] ? { id: sauces[0].id, name: sauces[0].name, priceCents: wrapSaucePriceCents } : null, priceCents: base.price_cents + sauces.length * wrapSaucePriceCents, breadQuantity: lineBreadQuantity });
  }
  if (breadQuantity > 30) return res.status(400).json({ error: 'You can add up to 30 extra breads per order.' });
  const foodTotalCents = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
  if (type === 'delivery' && foodTotalCents < 2000) return res.status(400).json({ error: `Delivery orders require at least €20,00 in food. Add €${((2000 - foodTotalCents) / 100).toFixed(2).replace('.', ',')} more.` });
  const deliveryFeeCents = type === 'delivery' ? 300 : 0;
  const totalCents = foodTotalCents + deliveryFeeCents + breadQuantity * 100;
  if (type === 'delivery') {
    const setting = db.prepare('SELECT value FROM restaurant_settings WHERE key = ?').get('delivery');
    if (setting?.value === 'closed' && !orderingTestMode) return res.status(409).json({ error: 'Delivery is currently unavailable.' });
    if (!validDeliveryAddress(verifiedAddress)) return res.status(400).json({ error: 'Enter a valid street, house number, postcode, city and supported country for delivery.' });
    const postcodes = approvedDeliveryPostcodes();
    if (!postcodes.length) return res.status(422).json({ error: 'Delivery is not available because no delivery postcodes have been configured yet. Please call the restaurant.' });
    if (!deliveryPostcodeIsApproved(postcodes, country, postcode)) {
      return res.status(422).json({ error: 'We do not deliver to this postcode. Please choose takeaway or call the restaurant.' });
    }
  }
  if (orderTime === 'asap') {
    const asapLeadMinutes = type === 'delivery' ? deliveryLeadMinutes : collectionPrepMinutes;
    if (orderDate !== today || (!orderingTestMode && !serviceIsOpen('orders'))) return res.status(400).json({ error: 'Choose a scheduled time that allows the required preparation or delivery time.' });
    if (type === 'delivery') {
      const earliestDelivery = getAvailableOrderSlots('delivery').slots[0];
      if (!earliestDelivery) return res.status(409).json({ error: 'No delivery times are currently available. Choose a scheduled time or try again later.' });
      orderDate = earliestDelivery.date;
      orderTime = earliestDelivery.time;
    } else if (orderingTestMode || asapLeadMinutes > 0) {
      return res.status(400).json({ error: 'Choose a scheduled time that allows the required preparation or delivery time.' });
    }
  } else {
    if (!orderingTestMode && !dateServiceIsOpen('orders', orderDate, orderTime)) return res.status(400).json({ error: 'That order time is outside the restaurant’s opening hours.' });
    const leadMinutes = type === 'delivery' ? deliveryLeadMinutes : (orderingTestMode ? testCollectionPrepMinutes : collectionPrepMinutes);
    const selectedSlot = localDateTimeCandidates(orderDate, orderTime).find(candidate => candidate.getTime() >= Date.now() + leadMinutes * 60000);
    if (!selectedSlot) return res.status(409).json({ error: type === 'delivery' ? `That delivery time is no longer available. Choose a time at least ${leadMinutes} minutes from now.` : `That pickup time is no longer available. Choose a time at least ${leadMinutes} minutes from now.` });
  }
  if (!orderingTestMode && type === 'delivery' && orderDate === today && !serviceEnabledToday('orders')) return res.status(409).json({ error: 'Ordering is currently closed today.' });
  if (legacyBreadQuantity) items.push({ id: null, name: 'Extra bread', quantity: legacyBreadQuantity, priceCents: 100, kind: 'extra' });
  const insertOrder = db.prepare('INSERT INTO orders (customer_name, phone, email, type, address, street, house_number, address_addition, postcode, city, country, delivery_instructions, test_mode, items_json, total_cents, order_time, order_date, payment_method, notes, client_request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let result;
  try {
    result = db.transaction(() => {
      const inserted = insertOrder.run(customerName, phone, email, type, address, type === 'delivery' ? street : '', type === 'delivery' ? houseNumber : '', type === 'delivery' ? addressAddition : '', type === 'delivery' ? postcode : '', type === 'delivery' ? city : '', type === 'delivery' ? country : '', type === 'delivery' ? deliveryInstructions : '', orderingTestMode ? 1 : 0, JSON.stringify(items), totalCents, orderTime, orderDate, paymentMethod, notes, requestId);
      queueOrderEmails(inserted.lastInsertRowid);
      return inserted;
    })();
  }
  catch (error) { if (String(error.code).includes('CONSTRAINT')) return res.status(409).json({ error: 'This order was already received.' }); throw error; }
  if (!orderingTestMode) scheduleEmailFlush();
  res.status(201).json({ orderId: result.lastInsertRowid, testMode: orderingTestMode });
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
  const requestId = cleanText(req.body.requestId, 80);
  if (!name || !validEmail(email) || !validPhone(phone) || !validFutureDate(reservationDate) || !Number.isInteger(guests) || guests < 1 || guests > 30 || !dateServiceIsOpen('reservations', reservationDate, reservationTime) || !/^[\da-f-]{36}$/i.test(requestId)) return res.status(400).json({ error: 'Reservations are only accepted on open days and during opening hours.' });
  const existing = db.prepare('SELECT id FROM reservations WHERE client_request_id = ?').get(requestId);
  if (existing) return res.status(200).json({ reservationId: existing.id, duplicate: true });
  const result = db.prepare('INSERT INTO reservations (name, email, phone, reservation_date, reservation_time, guests, purpose, notes, client_request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(name, email, phone, reservationDate, reservationTime, guests, purpose, notes, requestId);
  queueReservationEmails(result.lastInsertRowid);
  scheduleEmailFlush();
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
  queueEmail(`inquiry-${result.lastInsertRowid}-restaurant`, restaurantEmail, `New event inquiry to review · #${result.lastInsertRowid}`, `A new event inquiry was received.\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone}\nOccasion: ${purpose}\n\nMessage:\n${message}`);
  queueEmail(`inquiry-${result.lastInsertRowid}-customer`, email, 'We received your event inquiry · Mamanpaz Maastricht', 'Thank you for contacting Mamanpaz Maastricht. We have received your event inquiry and our team will be in touch soon.\n\nKind regards,\nMamanpaz Maastricht');
  scheduleEmailFlush();
  res.status(201).json({ inquiryId: result.lastInsertRowid });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC').all();
  const reservations = db.prepare('SELECT id, name, phone, created_at FROM reservations').all();
  res.json({ orders: addCustomerHistoryLabels(orders, reservations).orders });
});

app.get('/api/admin/test-notifications', requireAdmin, (_req, res) => {
  res.json({ notifications: db.prepare('SELECT * FROM test_notification_log ORDER BY id DESC LIMIT 100').all() });
});

app.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const allowed = ['new', 'accepted', 'rejected', 'preparing', 'ready', 'dispatched', 'completed', 'cancelled'];
  const status = cleanText(req.body.status, 30);
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid order status.' });
  const current = db.prepare('SELECT status, test_mode FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!current) return res.status(404).json({ error: 'Order not found.' });
  const transitions = { new: ['accepted', 'rejected', 'cancelled'], accepted: ['preparing', 'cancelled'], preparing: ['ready', 'cancelled'], ready: ['dispatched', 'completed', 'cancelled'], dispatched: ['completed', 'cancelled'], completed: [], cancelled: [], rejected: [] };
  if (status !== current.status && !transitions[current.status]?.includes(status)) return res.status(409).json({ error: `Order cannot move from ${current.status} to ${status}.` });
  const reason = status === 'rejected' ? cleanText(req.body.reason, 500) : '';
  if (!db.prepare('UPDATE orders SET status = ?, rejection_reason = ? WHERE id = ? AND status = ?').run(status, reason, Number(req.params.id), current.status).changes) return res.status(409).json({ error: 'This order was updated by another staff member. Refresh and try again.' });
  if (status !== current.status && ['accepted', 'rejected', 'preparing', 'ready', 'dispatched', 'completed', 'cancelled'].includes(status)) {
    queueOrderEmails(Number(req.params.id), status, reason);
    if (!current.test_mode) scheduleEmailFlush();
  }
  res.json({ ok: true });
});

app.delete('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const result = db.prepare('DELETE FROM orders WHERE id = ?').run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'Order not found.' });
  res.status(204).end();
});

app.get('/api/admin/reservations', requireAdmin, (req, res) => {
  const orders = db.prepare('SELECT id, customer_name, phone, created_at FROM orders').all();
  const reservations = db.prepare('SELECT * FROM reservations ORDER BY created_at DESC, id DESC').all();
  res.json({ reservations: addCustomerHistoryLabels(orders, reservations).reservations });
});

app.get('/api/admin/event-inquiries', requireAdmin, (req, res) => {
  res.json({ inquiries: db.prepare('SELECT * FROM event_inquiries ORDER BY created_at DESC').all() });
});

app.get('/api/admin/notifications', requireAdmin, (req, res) => {
  res.json({
    notifications: db.prepare(`SELECT id, event_key, recipient, subject, status, attempts, last_error, created_at, sent_at
      FROM notification_outbox
      WHERE status != 'sent' OR id IN (SELECT id FROM notification_outbox ORDER BY id DESC LIMIT 100)
      ORDER BY id DESC`).all(),
    configured: mailer.configured()
  });
});

app.post('/api/admin/notifications/:id/retry', requireAdmin, (req, res) => {
  const result = db.prepare("UPDATE notification_outbox SET status = 'pending', attempts = 0, last_error = '', next_attempt_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'sent'").run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'Unsent notification not found.' });
  scheduleEmailFlush();
  res.json({ ok: true });
});

app.patch('/api/admin/reservations/:id', requireAdmin, (req, res) => {
  const allowed = ['pending', 'confirmed', 'rejected', 'cancelled'];
  const status = cleanText(req.body.status, 30);
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid reservation status.' });
  const current = db.prepare('SELECT status FROM reservations WHERE id = ?').get(Number(req.params.id));
  if (!current) return res.status(404).json({ error: 'Reservation not found.' });
  const transitions = { pending: ['confirmed', 'rejected', 'cancelled'], confirmed: ['cancelled'], rejected: [], cancelled: [] };
  if (status !== current.status && !transitions[current.status]?.includes(status)) return res.status(409).json({ error: `Reservation cannot move from ${current.status} to ${status}.` });
  const reason = status === 'rejected' ? cleanText(req.body.reason, 500) : '';
  if (!db.prepare('UPDATE reservations SET status = ?, rejection_reason = ? WHERE id = ? AND status = ?').run(status, reason, Number(req.params.id), current.status).changes) return res.status(409).json({ error: 'This reservation was updated by another staff member. Refresh and try again.' });
  if (status !== current.status && ['confirmed', 'rejected', 'cancelled'].includes(status)) { queueReservationEmails(Number(req.params.id), status, reason, current.status === 'confirmed'); scheduleEmailFlush(); }
  res.json({ ok: true });
});

app.delete('/api/admin/reservations/:id', requireAdmin, (req, res) => {
  const result = db.prepare('DELETE FROM reservations WHERE id = ?').run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'Reservation not found.' });
  res.status(204).end();
});

app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
// The dashboard document contains the login form; all dashboard data/actions
// remain protected by requireAdmin on their API routes.
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
// Public assets live beside the server and database, so use an explicit allowlist.
const publicFiles = new Set([
  'index.html', 'menu.html', 'reservation.html', 'checkout.html', 'contactus.html',
  'event.html', 'aboutus.html', 'style.css', 'site.js', 'menu-runtime.js', 'cart-store.js', 'reviews-slideshow.js',
  'availability-runtime.js', 'admin.js', 'manifest.webmanifest', 'sw.js'
]);
const publicAssetPrefixes = ['/icons/', '/menu/', '/events/', '/backgroundpics/', '/uploads/'];
app.use((req, res, next) => {
  const isPublicFile = req.path === '/' || publicFiles.has(req.path.slice(1));
  const isPublicAsset = publicAssetPrefixes.some(prefix => req.path.startsWith(prefix));
  if (!isPublicFile && !isPublicAsset) return res.status(404).json({ error: 'Not found.' });
  next();
});
app.use((req, res, next) => {
  if (/\/(?:mamanpaz(?:-test)?\.sqlite(?:-(?:wal|shm))?|server\.js|mailer\.js)$/i.test(req.path)) return res.sendStatus(404);
  next();
});
app.use('/uploads', express.static(uploadRoot, { dotfiles: 'deny', index: false, maxAge: '1h', etag: true, lastModified: true }));
app.use(express.static(__dirname, {
  extensions: ['html'], dotfiles: 'deny', index: 'index.html', maxAge: '1h', etag: true, lastModified: true,
  setHeaders(res, filePath) {
    if (/\.(?:html|js|css|webmanifest)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.type === 'entity.too.large' ? 413
    : error.type === 'entity.parse.failed' ? 400 : 500;
  if (status === 500) console.error('Unhandled request error:', error.name || 'Error');
  const message = status === 413 ? 'Request body is too large.'
    : status === 400 ? 'Request body must contain valid JSON.'
      : 'Something went wrong. Please try again later.';
  res.status(status).json({ error: message });
});

db.prepare("UPDATE notification_outbox SET status = 'pending' WHERE status = 'sending'").run();
setInterval(() => flushEmailQueue().catch(reportEmailQueueFailure), 60 * 1000).unref();
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of requestWindows) {
    const active = times.filter(time => time > now - 15 * 60 * 1000);
    if (active.length) requestWindows.set(key, active); else requestWindows.delete(key);
  }
  for (const [token, session] of sessions) if (session.expiresAt < now) sessions.delete(token);
}, 5 * 60 * 1000).unref();

const onListening = () => console.log(`MamanPaz server running at http://${orderingTestMode ? '127.0.0.1' : 'localhost'}:${port}${orderingTestMode ? ' (ORDER TEST MODE ENABLED; test orders only)' : ''}`);
const httpServer = orderingTestMode ? app.listen(port, '127.0.0.1', onListening) : app.listen(port, onListening);
httpServer.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Stop the existing Mamanpaz server with Ctrl+C, then start this one again.`);
    db.close();
    process.exitCode = 1;
    return;
  }
  console.error('Could not start the Mamanpaz server:', error.message);
  db.close();
  process.exitCode = 1;
});
