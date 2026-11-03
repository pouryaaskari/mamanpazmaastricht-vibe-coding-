const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { hashPassword, verifyPassword, resetStaffPassword } = require('../staff-auth');

const root = path.resolve(__dirname, '..');
const username = 'integration-test@example.invalid';
const password = 'Isolated-Integration-Test-Password-7492!';
let tempRoot;
let server;
let baseUrl;
let serverOutput = '';
let menu;
let wrap;
let baghali;
let sauces;
let drink;
let pickupSlot;
let deliverySlot;
let adminCookie;

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function request(url, options = {}) {
  const response = await fetch(`${baseUrl}${url}`, options);
  const body = await response.json().catch(() => null);
  return { response, body };
}

function jsonOptions(method, body, cookie = '') {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body)
  };
}

before(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mamanpaz-integration-'));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempRoot, 'audit.sqlite'),
      ORDER_TEST_DB_PATH: path.join(tempRoot, 'audit-test.sqlite'),
      UPLOAD_DIR: path.join(tempRoot, 'uploads'),
      ORDER_TEST_MODE: 'true',
      NODE_ENV: 'development',
      ADMIN_USERNAME: username,
      ADMIN_PASSWORD: password,
      SMTP_USER: '',
      SMTP_APP_PASSWORD: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => { serverOutput += chunk; });
  server.stderr.on('data', chunk => { serverOutput += chunk; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Test server exited early:\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/settings/order-mode`);
      if (response.ok) break;
    } catch (_) { /* Wait for the isolated server to bind its port. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const mode = await fetch(`${baseUrl}/api/settings/order-mode`).then(response => response.json());
  assert.equal(mode.testMode, true, 'integration server must run in isolated test mode');
  assert.equal(fs.existsSync(path.join(tempRoot, 'audit.sqlite')), false, 'test mode must leave the normal database untouched');
  assert.equal(fs.existsSync(path.join(tempRoot, 'audit-test.sqlite')), true, 'test mode must open its separate database');
  const menuResponse = await request('/api/menu');
  assert.equal(menuResponse.response.status, 200);
  menu = menuResponse.body.items;
  wrap = menu.find(item => item.category === 'wraps');
  baghali = menu.find(item => item.name === 'baghali polo ba goosht');
  sauces = menu.filter(item => item.category === 'sauces').slice(0, 2);
  drink = menu.find(item => item.category === 'drinks');
  assert(wrap && baghali && sauces.length === 2 && drink, 'seed menu contains a wrap, scheduled Baghali Polo, two sauces, and a drink');
  pickupSlot = (await request('/api/order-slots?type=pickup')).body.slots[0];
  deliverySlot = (await request('/api/order-slots?type=delivery')).body.slots[0];
  const login = await fetch(`${baseUrl}/api/auth/login`, jsonOptions('POST', { username, password }));
  assert.equal(login.status, 200);
  adminCookie = login.headers.get('set-cookie').split(';')[0];
  const postcodeSetup = await request('/api/admin/delivery-postcodes', jsonOptions('POST', { postcode: '6217 CT', country: 'Netherlands' }, adminCookie));
  assert.equal(postcodeSetup.response.status, 201, 'the isolated test database explicitly approves the fixture postcode');
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => server.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('public pages and route-safe staff assets are served', async () => {
  for (const route of ['/', '/menu.html', '/checkout.html', '/reservation.html', '/event.html', '/contactus.html', '/aboutus.html', '/admin/login']) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200, route);
  }
  const checkoutPage = await fetch(`${baseUrl}/checkout.html`).then(response => response.text());
  assert.match(checkoutPage, /id="orderDate" type="date"/);
  assert.match(checkoutPage, /id="closedDayModal"/);
  const adminPage = await fetch(`${baseUrl}/admin.html`).then(response => response.text());
  assert.match(adminPage, /id="deliveryPostcodeForm"/);
  assert.match(adminPage, /id="deliveryPostcodeList"/);
  const menuPage = await fetch(`${baseUrl}/menu.html`).then(response => response.text());
  assert.doesNotMatch(menuPage, /menu\/optimized\/[^"]+\.jpg/i, 'static menu photos use transparent PNGs');
  const menuResponse = await request('/api/menu');
  assert.equal(menuResponse.response.status, 200);
  const photoPaths = menuResponse.body.items.map(item => item.image).filter(image => /^menu\/optimized\/.+\.png$/i.test(image));
  assert(photoPaths.length >= 30, 'database menu maps its photos to optimized transparent PNGs');
  await Promise.all(photoPaths.map(async image => {
    const response = await fetch(`${baseUrl}/${image}`);
    assert.equal(response.status, 200, image);
    assert.match(response.headers.get('content-type'), /image\/png/i);
    const png = Buffer.from(await response.arrayBuffer());
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', image);
    assert.equal(png[25], 6, `${image} includes an alpha channel`);
  }));
  for (const asset of ['/style.css', '/admin.js', '/reviews-slideshow.js', '/manifest.webmanifest', '/cart-store.js']) {
    const response = await fetch(`${baseUrl}${asset}`);
    assert.equal(response.status, 200, asset);
  }
  const staffPage = await fetch(`${baseUrl}/admin/login`).then(response => response.text());
  assert.match(staffPage, /href="\/style\.css/);
  assert.match(staffPage, /src="\/admin\.js/);
});

test('test mode refuses to use the production database path', () => {
  const samePath = path.join(tempRoot, 'must-not-open.sqlite');
  const result = spawnSync(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: '0', DB_PATH: samePath, ORDER_TEST_DB_PATH: samePath,
      ORDER_TEST_MODE: 'true', NODE_ENV: 'development', SMTP_USER: '', SMTP_APP_PASSWORD: ''
    },
    encoding: 'utf8',
    timeout: 10000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ORDER_TEST_DB_PATH must point to a separate database/);
  assert.equal(fs.existsSync(samePath), false, 'rejected configuration must not create or modify the shared database');
});

test('production refuses to start without a strong initial staff password', () => {
  const dbPath = path.join(tempRoot, 'weak-production.sqlite');
  const result = spawnSync(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: '0',
      DB_PATH: dbPath,
      ORDER_TEST_DB_PATH: path.join(tempRoot, 'weak-production-test.sqlite'),
      ORDER_TEST_MODE: 'false',
      NODE_ENV: 'production',
      ADMIN_USERNAME: username,
      ADMIN_PASSWORD: 'too-short',
      SMTP_USER: '',
      SMTP_APP_PASSWORD: ''
    },
    encoding: 'utf8',
    timeout: 10000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /initial production staff password must contain at least 16 characters/i);
});

test('production ignores the order test-mode flag', async () => {
  const productionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mamanpaz-production-mode-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(productionRoot, 'production.sqlite'),
      ORDER_TEST_DB_PATH: path.join(productionRoot, 'production-test.sqlite'),
      UPLOAD_DIR: path.join(productionRoot, 'uploads'),
      ORDER_TEST_MODE: 'true',
      NODE_ENV: 'production',
      ADMIN_USERNAME: username,
      ADMIN_PASSWORD: password,
      SMTP_USER: '',
      SMTP_APP_PASSWORD: ''
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let output = '';
  child.stderr.on('data', chunk => { output = `${output}${chunk}`; });
  try {
    const deadline = Date.now() + 15000;
    let mode;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Production test server exited early:\n${output}`);
      try {
        const response = await fetch(`${url}/api/settings/order-mode`);
        if (response.ok) { mode = await response.json(); break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(mode?.testMode, false);
    assert.equal(fs.existsSync(path.join(productionRoot, 'production.sqlite')), true);
    assert.equal(fs.existsSync(path.join(productionRoot, 'production-test.sqlite')), false);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2500))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(productionRoot, { recursive: true, force: true });
  }
});

test('production initializes configured persistent paths and preserves existing database data', async () => {
  const deployRoot = path.join(tempRoot, 'render-volume');
  const dbPath = path.join(deployRoot, 'database', 'mamanpaz.sqlite');
  const uploadPath = path.join(deployRoot, 'uploads');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const start = adminPassword => {
    const child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        DB_PATH: dbPath,
        UPLOAD_DIR: uploadPath,
        ORDER_TEST_MODE: 'false',
        NODE_ENV: 'production',
        ADMIN_USERNAME: username,
        ADMIN_PASSWORD: adminPassword,
        SMTP_USER: '',
        SMTP_APP_PASSWORD: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    return { child, getOutput: () => output };
  };
  const waitUntilReady = async ({ child, getOutput }) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Persistent-path test server exited early:\n${getOutput()}`);
      try {
        const response = await fetch(`${url}/api/settings/order-mode`);
        if (response.ok) return response.json();
      } catch (_) { /* Wait for the isolated production server to bind its port. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Persistent-path test server did not become ready:\n${getOutput()}`);
  };
  const stop = async child => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  let running;
  try {
    running = start(password);
    const mode = await waitUntilReady(running);
    assert.equal(mode.testMode, false);
    assert(fs.existsSync(dbPath), 'database file is created under configured DB_PATH');
    assert(fs.existsSync(uploadPath), 'configured upload directory is created before serving requests');

    const db = new Database(dbPath);
    const tableNames = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name));
    for (const table of ['orders', 'reservations', 'event_inquiries', 'menu_items', 'restaurant_settings', 'staff_users', 'notification_outbox', 'test_notification_log']) {
      assert(tableNames.has(table), `empty persistent database initializes ${table}`);
    }
    const staff = db.prepare('SELECT username, password_hash FROM staff_users').get();
    assert.equal(staff.username, username);
    assert.notEqual(staff.password_hash, password, 'initial production password is stored as a hash');
    assert.equal(verifyPassword(password, staff.password_hash), true);
    db.prepare('INSERT INTO restaurant_settings (key, value) VALUES (?, ?)').run('deploy_persistence_test', 'preserve-me');
    db.close();

    const login = await fetch(`${url}/api/auth/login`, jsonOptions('POST', { username, password }));
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJgAAAABJRU5ErkJggg==', 'base64');
    const upload = await fetch(`${url}/api/admin/menu-image`, jsonOptions('POST', { dataUrl: `data:image/png;base64,${png.toString('base64')}` }, cookie)).then(response => response.json());
    const savedImage = path.join(uploadPath, 'menu', path.basename(upload.image));
    assert.match(upload.image, /^\/uploads\/menu\//);
    assert(fs.existsSync(savedImage), 'uploaded image bytes are stored below UPLOAD_DIR');

    await stop(running.child);
    running = start('A-different-long-production-password-927!');
    await waitUntilReady(running);
    const restartedDb = new Database(dbPath, { readonly: true });
    assert.equal(restartedDb.prepare("SELECT value FROM restaurant_settings WHERE key = 'deploy_persistence_test'").get().value, 'preserve-me');
    const restartedStaff = restartedDb.prepare('SELECT password_hash FROM staff_users WHERE username = ?').get(username);
    assert.equal(restartedStaff.password_hash, staff.password_hash, 'restart does not overwrite the existing staff account');
    restartedDb.close();
    const originalLogin = await fetch(`${url}/api/auth/login`, jsonOptions('POST', { username, password }));
    const changedLogin = await fetch(`${url}/api/auth/login`, jsonOptions('POST', { username, password: 'A-different-long-production-password-927!' }));
    assert.equal(originalLogin.status, 200);
    assert.equal(changedLogin.status, 401);
  } finally {
    if (running) await stop(running.child);
  }
});

test('production startup reports inaccessible database and upload paths clearly', () => {
  const dbPathIsDirectory = path.join(tempRoot, 'database-path-is-directory');
  fs.mkdirSync(dbPathIsDirectory);
  const databaseParentFile = path.join(tempRoot, 'database-parent-is-file');
  fs.writeFileSync(databaseParentFile, 'not a directory');
  const inaccessibleUploadFile = path.join(tempRoot, 'upload-path-is-file');
  fs.writeFileSync(inaccessibleUploadFile, 'not a directory');
  const runWith = (dbPath, uploadPath) => spawnSync(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: '0',
      DB_PATH: dbPath,
      UPLOAD_DIR: uploadPath,
      ORDER_TEST_MODE: 'false',
      NODE_ENV: 'production',
      ADMIN_USERNAME: username,
      ADMIN_PASSWORD: password,
      SMTP_USER: '',
      SMTP_APP_PASSWORD: ''
    },
    encoding: 'utf8',
    timeout: 10000
  });
  const databaseFailure = runWith(dbPathIsDirectory, path.join(tempRoot, 'unused-upload-directory'));
  assert.notEqual(databaseFailure.status, 0);
  assert.match(databaseFailure.stderr, /Cannot access existing SQLite database .*database-path-is-directory/i);
  assert.match(databaseFailure.stderr, /not a regular file/i);
  const databaseDirectoryFailure = runWith(path.join(databaseParentFile, 'mamanpaz.sqlite'), path.join(tempRoot, 'unused-upload-directory'));
  assert.notEqual(databaseDirectoryFailure.status, 0);
  assert.match(databaseDirectoryFailure.stderr, /Cannot access writable database directory .*database-parent-is-file/i);
  const uploadFailure = runWith(path.join(tempRoot, 'must-not-open.sqlite'), inaccessibleUploadFile);
  assert.notEqual(uploadFailure.status, 0);
  assert.match(uploadFailure.stderr, /Cannot access writable upload directory .*upload-path-is-file/i);
  assert.equal(fs.existsSync(path.join(tempRoot, 'must-not-open.sqlite')), false, 'upload path is validated before creating a database');
});

test('production database preparation copies only verified configuration and refuses overwrite', async () => {
  const sourcePath = path.join(tempRoot, 'production-config-fixture.sqlite');
  const outputPath = path.join(tempRoot, 'clean-production.sqlite');
  const existingTestDb = new Database(path.join(tempRoot, 'audit-test.sqlite'));
  await existingTestDb.backup(sourcePath);
  existingTestDb.close();

  const source = new Database(sourcePath);
  source.prepare("INSERT INTO restaurant_settings (key, value) VALUES ('delivery', 'closed') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  source.prepare("UPDATE menu_items SET available_days = ?, description = ? WHERE lower(name) LIKE 'baghali polo ba %'")
    .run('["friday"]', 'Alleen verkrijgbaar op vrijdag. Synthetic source description.');
  source.prepare('INSERT INTO staff_users (username, password_hash) VALUES (?, ?)').run('synthetic-staff', 'synthetic-hash');
  const order = source.prepare("INSERT INTO orders (customer_name, phone, type, items_json, total_cents) VALUES (?, ?, 'pickup', '[]', 0)").run('synthetic-test', '000000');
  source.prepare('INSERT INTO test_notification_log (order_id, event_key, subject, body) VALUES (?, ?, ?, ?)')
    .run(order.lastInsertRowid, 'synthetic-test', 'synthetic', 'synthetic');
  source.prepare("INSERT INTO reservations (name, email, phone, reservation_date, reservation_time, guests) VALUES ('synthetic', 'synthetic@example.invalid', '000000', '2030-01-01', '18:00', 2)").run();
  source.prepare("INSERT INTO event_inquiries (name, email, phone, purpose) VALUES ('synthetic', 'synthetic@example.invalid', '000000', 'synthetic')").run();
  source.prepare("INSERT INTO notification_outbox (event_key, recipient, subject, body) VALUES ('synthetic', 'synthetic@example.invalid', 'synthetic', 'synthetic')").run();
  const sourceMenu = source.prepare(`
    SELECT id, name, name_fa, description, price_cents, category, image, available,
      available_days, sort_order, created_at, updated_at
    FROM menu_items ORDER BY id
  `).all();
  source.close();

  const result = spawnSync(process.execPath, [path.join(root, 'scripts/prepare-production-database.js')], {
    cwd: root,
    env: {
      ...process.env,
      PRODUCTION_SOURCE_DB_PATH: sourcePath,
      PRODUCTION_DB_OUTPUT_PATH: outputPath
    },
    encoding: 'utf8',
    timeout: 30000
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const productionDb = new Database(outputPath, { readonly: true, fileMustExist: true });
  productionDb.pragma('query_only = ON');
  const productionMenu = productionDb.prepare(`
    SELECT id, name, name_fa, description, price_cents, category, image, available,
      available_days, sort_order, created_at, updated_at
    FROM menu_items ORDER BY id
  `).all();
  assert.equal(productionMenu.length, 43);
  const expectedMenu = sourceMenu.map(item => /baghali polo ba (gosht|goosht)/i.test(item.name) ? {
    ...item,
    available_days: '["friday"]',
    description: 'Alleen verkrijgbaar op vrijdag. Synthetic source description.'
  } : item);
  assert.deepEqual(productionMenu, expectedMenu, 'prices, descriptions, images, names, and weekday restrictions are preserved');
  assert.equal(productionDb.prepare("SELECT value FROM restaurant_settings WHERE key = 'delivery'").get().value, 'open');
  const businessHours = JSON.parse(productionDb.prepare("SELECT value FROM restaurant_settings WHERE key = 'business_hours'").get().value);
  for (const [day, expectedOpen] of [['monday', false], ['tuesday', false], ['wednesday', true], ['thursday', true], ['friday', true], ['saturday', true], ['sunday', true]]) {
    assert.equal(businessHours[day].open, expectedOpen);
    assert.equal(businessHours[day].opens, '16:30');
    assert.equal(businessHours[day].closes, '22:00');
    assert.equal(businessHours[day].orders, expectedOpen);
    assert.equal(businessHours[day].reservations, expectedOpen);
  }
  for (const table of ['staff_users', 'orders', 'reservations', 'event_inquiries', 'notification_outbox', 'test_notification_log']) {
    assert.equal(productionDb.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count, 0);
  }
  productionDb.close();

  const before = crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex');
  const secondRun = spawnSync(process.execPath, [path.join(root, 'scripts/prepare-production-database.js')], {
    cwd: root,
    env: {
      ...process.env,
      PRODUCTION_SOURCE_DB_PATH: sourcePath,
      PRODUCTION_DB_OUTPUT_PATH: outputPath
    },
    encoding: 'utf8',
    timeout: 10000
  });
  assert.notEqual(secondRun.status, 0);
  assert.match(secondRun.stderr, /Refusing to overwrite an existing production database/);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex'), before);
});

test('existing weekly schedule migration moves Baghali Polo to Friday without changing Loobia Polo', async () => {
  const legacyDbPath = path.join(tempRoot, 'legacy-schedule.sqlite');
  const legacyDb = new Database(legacyDbPath);
  legacyDb.exec(`
    CREATE TABLE menu_items (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_fa TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL,
      category TEXT NOT NULL, image TEXT NOT NULL DEFAULT '', available INTEGER NOT NULL DEFAULT 1,
      available_days TEXT NOT NULL DEFAULT '[]', sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE restaurant_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO restaurant_settings (key, value) VALUES ('dish_schedule_v2_initialized', 'yes');
    INSERT INTO restaurant_settings (key, value) VALUES ('dish_schedule_v3_initialized', 'yes');
    INSERT INTO restaurant_settings (key, value) VALUES ('dish_schedule_v4_initialized', 'yes');
  `);
  legacyDb.prepare('INSERT INTO menu_items (name, description, price_cents, category, available_days) VALUES (?, ?, ?, ?, ?)').run('baghali polo ba goosht', 'Alleen verkrijgbaar op zaterdag. Rice and beef.', 2000, 'rice', '["saturday"]');
  legacyDb.prepare('INSERT INTO menu_items (name, description, price_cents, category, available_days) VALUES (?, ?, ?, ?, ?)').run('loobia polo', 'Alleen verkrijgbaar op zaterdag. Rice and beans.', 2000, 'rice', '["saturday"]');
  legacyDb.close();

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempRoot, 'unused-production.sqlite'),
      ORDER_TEST_DB_PATH: legacyDbPath,
      UPLOAD_DIR: path.join(tempRoot, 'legacy-uploads'),
      ORDER_TEST_MODE: 'true',
      NODE_ENV: 'development',
      ADMIN_USERNAME: '',
      ADMIN_PASSWORD: '',
      SMTP_USER: '',
      SMTP_APP_PASSWORD: ''
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    let response;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Migration test server exited early:\n${output}`);
      try {
        response = await fetch(`${url}/api/menu`);
        if (response.ok) break;
      } catch (_) { /* Wait for the isolated migration server to bind its port. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(response?.status, 200);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 2500))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  const migratedDb = new Database(legacyDbPath, { readonly: true });
  const baghaliSchedule = migratedDb.prepare("SELECT available_days, description FROM menu_items WHERE name = 'baghali polo ba goosht'").get();
  const loobiaSchedule = migratedDb.prepare("SELECT available_days FROM menu_items WHERE name = 'loobia polo'").get();
  const marker = migratedDb.prepare("SELECT value FROM restaurant_settings WHERE key = 'dish_schedule_v5_initialized'").get();
  migratedDb.close();
  assert.deepEqual(JSON.parse(baghaliSchedule.available_days), ['friday']);
  assert.match(baghaliSchedule.description, /^Alleen verkrijgbaar op vrijdag\./);
  assert.deepEqual(JSON.parse(loobiaSchedule.available_days), ['saturday']);
  assert.equal(marker.value, 'yes');
});

test('staff password rotation updates only the matching account and requires a strong password', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE staff_users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT)');
  db.prepare('INSERT INTO staff_users (username, password_hash) VALUES (?, ?)').run('staff@example.invalid', hashPassword('previous-password-long-enough'));
  assert.throws(() => resetStaffPassword(db, 'staff@example.invalid', 'short'), /at least 16 characters/);
  assert.throws(() => resetStaffPassword(db, 'missing@example.invalid', 'new-password-long-enough'), /No staff account/);
  resetStaffPassword(db, 'staff@example.invalid', 'new-password-long-enough');
  const stored = db.prepare('SELECT password_hash FROM staff_users WHERE username = ?').get('staff@example.invalid').password_hash;
  assert.equal(verifyPassword('new-password-long-enough', stored), true);
  assert.equal(verifyPassword('previous-password-long-enough', stored), false);
  db.close();
});

test('order slots are future dated and enforce type-specific lead times', async () => {
  for (const [type, slot, lead] of [['pickup', pickupSlot, 15], ['delivery', deliverySlot, 30]]) {
    const result = await request(`/api/order-slots?type=${type}`);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.testMode, true);
    assert.equal(result.body.leadMinutes, lead);
    assert.equal(result.body.asap, type === 'delivery');
    assert(slot && new Date(slot.instant).getTime() >= Date.now() + lead * 60000);
    assert.equal(new Set(result.body.slots.map(item => item.date)).size, 21, 'test availability covers three weeks');
  }
  const invalid = await request('/api/order-slots?type=sideways');
  assert.equal(invalid.response.status, 400);
});

test('live schedules orders for upcoming open days while closed and uses 30-minute lead times', async () => {
  const normalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mamanpaz-normal-schedule-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(normalRoot, 'normal.sqlite'),
      ORDER_TEST_DB_PATH: path.join(normalRoot, 'normal-test.sqlite'),
      UPLOAD_DIR: path.join(normalRoot, 'uploads'),
      ORDER_TEST_MODE: 'false',
      ORDER_COLLECTION_PREP_MINUTES: '30',
      NODE_ENV: 'test',
      ADMIN_USERNAME: username,
      ADMIN_PASSWORD: password,
      SMTP_USER: '',
      SMTP_APP_PASSWORD: ''
    },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  try {
    let mode;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Production-mode test server exited before becoming ready.');
      try {
        const response = await fetch(`${url}/api/settings/order-mode`);
        if (response.ok) { mode = await response.json(); break; }
      } catch (_) { /* Wait for server startup. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(mode?.testMode, false, 'live ordering runs outside test mode');
    assert.equal(fs.existsSync(path.join(normalRoot, 'normal.sqlite')), true, 'normal ordering uses the production database path');
    assert.equal(fs.existsSync(path.join(normalRoot, 'normal-test.sqlite')), false, 'normal ordering does not open the test database path');
    const login = await fetch(`${url}/api/auth/login`, jsonOptions('POST', { username, password }));
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const postcodeSetup = await fetch(`${url}/api/admin/delivery-postcodes`, jsonOptions('POST', { postcode: '6217 CT', country: 'Netherlands' }, cookie));
    assert.equal(postcodeSetup.status, 201);
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const setHours = async open => {
      const hours = Object.fromEntries(days.map(day => {
        const isOpen = typeof open === 'boolean' ? open : Array.isArray(open) ? open.includes(day) : day === open;
        return [day, { open: isOpen, opens: '00:00', closes: '23:59', orders: isOpen, reservations: isOpen }];
      }));
      const response = await fetch(`${url}/api/admin/settings/business-hours`, jsonOptions('PATCH', { hours }, cookie));
      assert.equal(response.status, 200);
    };
    await setHours(false);
    for (const type of ['pickup', 'delivery']) {
      const closed = await fetch(`${url}/api/order-slots?type=${type}`).then(response => response.json());
      assert.equal(closed.slots.length, 0, `${type} has no slots while the restaurant is closed`);
      assert.equal(closed.asap, false, `${type} cannot be ordered ASAP while the restaurant is closed`);
    }
    const hoursNow = await fetch(`${url}/api/settings/business-hours`).then(response => response.json());
    const tomorrow = new Date(`${hoursNow.todayDate}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const tomorrowDate = tomorrow.toISOString().slice(0, 10);
    const tomorrowWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Amsterdam', weekday: 'long' })
      .format(new Date(`${tomorrowDate}T12:00:00Z`)).toLowerCase();
    const closedDate = new Date(`${tomorrowDate}T12:00:00Z`);
    closedDate.setUTCDate(closedDate.getUTCDate() + 1);
    const closedDateValue = closedDate.toISOString().slice(0, 10);
    const secondOpenDate = new Date(`${tomorrowDate}T12:00:00Z`);
    secondOpenDate.setUTCDate(secondOpenDate.getUTCDate() + 2);
    const secondOpenDateValue = secondOpenDate.toISOString().slice(0, 10);
    const secondOpenWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Amsterdam', weekday: 'long' })
      .format(secondOpenDate).toLowerCase();
    const firstOpenFollowingWeeks = [7, 14].map(days => {
      const date = new Date(`${tomorrowDate}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    });
    const secondOpenFollowingWeeks = [7, 14].map(days => {
      const date = new Date(`${secondOpenDateValue}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    });
    const expectedOpenDates = [tomorrowDate, secondOpenDateValue, ...firstOpenFollowingWeeks, ...secondOpenFollowingWeeks].sort();
    await setHours(tomorrowWeekday);
    const firstOpenDaySlots = await fetch(`${url}/api/order-slots?type=pickup`).then(response => response.json());
    assert.deepEqual([...new Set(firstOpenDaySlots.slots.map(slot => slot.date))], [tomorrowDate, ...firstOpenFollowingWeeks]);
    await setHours([tomorrowWeekday, secondOpenWeekday]);
    const futureSlots = {};
    const secondFutureSlots = {};
    for (const type of ['pickup', 'delivery']) {
      const result = await fetch(`${url}/api/order-slots?type=${type}`).then(response => response.json());
      assert(result.slots.length > 0, `${type} has slots on the next open day while closed today`);
      assert.deepEqual([...new Set(result.slots.map(slot => slot.date))], expectedOpenDates, `${type} offers only the configured open days`);
      assert.equal(result.asap, false, `${type} cannot be ordered ASAP while currently closed`);
      futureSlots[type] = result.slots[0];
      secondFutureSlots[type] = result.slots.find(slot => slot.date === secondOpenDateValue);
    }

    const futureMenu = await fetch(`${url}/api/menu`).then(response => response.json());
    const scheduledItem = futureMenu.items.find(item => item.category === 'wraps');
    assert(scheduledItem, 'production menu contains a wrap for a scheduled order');
    const closedDayOrder = await fetch(`${url}/api/orders`, jsonOptions('POST', {
      requestId: crypto.randomUUID(),
      customerName: 'Closed-Day Rejected Order',
      phone: '+31612345678',
      email: 'closed-day-order@example.invalid',
      type: 'pickup',
      orderDate: closedDateValue,
      orderTime: '12:00',
      paymentMethod: 'cash',
      items: [{ id: scheduledItem.id, quantity: 1, sauceIds: [], breadQuantity: 0 }],
      breadQuantity: 0
    }));
    assert.equal(closedDayOrder.status, 400, 'orders are rejected for a future day when ordering is closed');
    for (const type of ['pickup', 'delivery']) {
      const order = await fetch(`${url}/api/orders`, jsonOptions('POST', {
        requestId: crypto.randomUUID(),
        customerName: `Closed-Day ${type} Order`,
        phone: '+31612345678',
        email: `${type}-closed-day@example.invalid`,
        type,
        orderDate: futureSlots[type].date,
        orderTime: futureSlots[type].time,
        paymentMethod: 'cash',
        deliveryAddress: type === 'delivery'
          ? { street: 'Teststraat', houseNumber: '10', postcode: '6217 CT', city: 'Maastricht', country: 'Netherlands' }
          : undefined,
        items: [{ id: scheduledItem.id, quantity: type === 'delivery' ? 2 : 1, sauceIds: [], breadQuantity: 0 }],
        breadQuantity: 0
      }));
      assert.equal(order.status, 201, `${type} order can be scheduled for an upcoming open day`);
      const secondOrder = await fetch(`${url}/api/orders`, jsonOptions('POST', {
        requestId: crypto.randomUUID(),
        customerName: `Second Future ${type} Order`,
        phone: '+31612345678',
        email: `second-${type}-future@example.invalid`,
        type,
        orderDate: secondFutureSlots[type].date,
        orderTime: secondFutureSlots[type].time,
        paymentMethod: 'cash',
        deliveryAddress: type === 'delivery'
          ? { street: 'Teststraat', houseNumber: '10', postcode: '6217 CT', city: 'Maastricht', country: 'Netherlands' }
          : undefined,
        items: [{ id: scheduledItem.id, quantity: type === 'delivery' ? 2 : 1, sauceIds: [], breadQuantity: 0 }],
        breadQuantity: 0
      }));
      assert.equal(secondOrder.status, 201, `${type} order can be scheduled on another configured open day`);
    }

    const futureReservation = await fetch(`${url}/api/reservations`, jsonOptions('POST', {
      requestId: crypto.randomUUID(),
      name: 'Closed-Day Integration Guest',
      email: 'closed-day-guest@example.invalid',
      phone: '+31612345678',
      date: tomorrowDate,
      time: '17:00',
      guests: 2,
      purpose: 'dinner',
      notes: ''
    }));
    assert.equal(futureReservation.status, 201, 'reservation can be requested for an upcoming open day while currently closed');
    const closedDayReservation = await fetch(`${url}/api/reservations`, jsonOptions('POST', {
      requestId: crypto.randomUUID(),
      name: 'Closed-Day Rejected Guest',
      email: 'closed-day-rejected@example.invalid',
      phone: '+31612345678',
      date: closedDateValue,
      time: '17:00',
      guests: 2,
      purpose: 'dinner',
      notes: ''
    }));
    assert.equal(closedDayReservation.status, 400, 'reservations are rejected for a future day when reservations are closed');

    await setHours(true);
    let deliverySlots;
    for (const type of ['pickup', 'delivery']) {
      const open = await fetch(`${url}/api/order-slots?type=${type}`).then(response => response.json());
      assert.equal(open.leadMinutes, 30);
      assert(open.slots.length > 0);
      assert(new Date(open.slots[0].instant).getTime() >= new Date(open.serverNow).getTime() + 30 * 60000);
      assert.equal(open.asap, type === 'delivery');
      if (type === 'delivery') deliverySlots = open;
    }
    const productionMenu = await fetch(`${url}/api/menu`).then(response => response.json());
    const deliveryItem = productionMenu.items.find(item => item.category === 'wraps');
    assert(deliveryItem, 'production menu contains a wrap for the ASAP delivery order');
    const requestId = crypto.randomUUID();
    const asapOrder = await fetch(`${url}/api/orders`, jsonOptions('POST', {
      requestId,
      customerName: 'ASAP Integration Delivery',
      phone: '+31612345678',
      email: 'asap-delivery@example.invalid',
      type: 'delivery',
      orderDate: deliverySlots.today,
      orderTime: 'asap',
      paymentMethod: 'cash',
      deliveryAddress: { street: 'Teststraat', houseNumber: '10', postcode: '6217 CT', city: 'Maastricht', country: 'Netherlands' },
      items: [{ id: deliveryItem.id, quantity: 2, sauceIds: [], breadQuantity: 0 }],
      breadQuantity: 0
    }));
    assert.equal(asapOrder.status, 201, JSON.stringify(await asapOrder.json()));
    const productionDb = new Database(path.join(normalRoot, 'normal.sqlite'), { readonly: true });
    const savedOrder = productionDb.prepare('SELECT order_date, order_time FROM orders WHERE client_request_id = ?').get(requestId);
    productionDb.close();
    const savedSlot = deliverySlots.slots.find(slot => slot.date === savedOrder.order_date && slot.time === savedOrder.order_time);
    assert(savedSlot, 'ASAP delivery is assigned to an available scheduled slot');
    assert(new Date(savedSlot.instant).getTime() >= new Date(deliverySlots.serverNow).getTime() + 30 * 60000);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2500))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(normalRoot, { recursive: true, force: true });
  }
});

test('cart pricing includes two sauces and per-item plus standalone bread; retries are idempotent', async () => {
  const currentPickupSlot = (await request('/api/order-slots?type=pickup')).body.slots[0];
  const requestId = crypto.randomUUID();
  const payload = {
    requestId, customerName: 'Integration Pickup', phone: '+31612345678', email: 'pickup@example.invalid',
    type: 'pickup', orderDate: currentPickupSlot.date, orderTime: currentPickupSlot.time, paymentMethod: 'cash',
    items: [{ id: wrap.id, quantity: 2, sauceIds: sauces.map(item => item.id), breadQuantity: 2 }],
    breadQuantity: 1, notes: 'isolated integration test'
  };
  const first = await request('/api/orders', jsonOptions('POST', payload));
  assert.equal(first.response.status, 201, JSON.stringify(first.body));
  const expected = (wrap.price_cents + 2 * 50) * 2 + 2 * 100 + 100;
  const db = new Database(path.join(tempRoot, 'audit-test.sqlite'), { readonly: true });
  const saved = db.prepare('SELECT total_cents, items_json, test_mode FROM orders WHERE id = ?').get(first.body.orderId);
  db.close();
  assert.equal(saved.total_cents, expected);
  assert.equal(saved.test_mode, 1);
  assert.equal(JSON.parse(saved.items_json)[0].sauces.length, 2);
  const retry = await request('/api/orders', jsonOptions('POST', payload));
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.orderId, first.body.orderId);
  assert.equal(retry.body.duplicate, true);
});

test('delivery minimum, address validation, and sauce limits reject invalid carts', async () => {
  const common = {
    customerName: 'Integration Delivery', phone: '+31612345678', email: 'delivery@example.invalid',
    type: 'delivery', orderDate: deliverySlot.date, orderTime: deliverySlot.time,
    paymentMethod: 'cash', deliveryAddress: { street: 'Teststraat', houseNumber: '10', postcode: '6217 CT', city: 'Maastricht', country: 'Netherlands' }
  };
  const tooSmall = await request('/api/orders', jsonOptions('POST', {
    ...common, requestId: crypto.randomUUID(), items: [{ id: drink.id, quantity: 1, sauceIds: [], breadQuantity: 0 }], breadQuantity: 0
  }));
  assert.equal(tooSmall.response.status, 400);
  assert.match(tooSmall.body.error, /20,00/);

  const invalidAddress = await request('/api/orders', jsonOptions('POST', {
    ...common, requestId: crypto.randomUUID(), deliveryAddress: { street: 'X', houseNumber: '', postcode: '', city: '' },
    items: [{ id: wrap.id, quantity: 20, sauceIds: [], breadQuantity: 0 }], breadQuantity: 0
  }));
  assert.equal(invalidAddress.response.status, 400);
  assert.match(invalidAddress.body.error, /street, house number/);

  const duplicateSauce = await request('/api/orders', jsonOptions('POST', {
    ...common, requestId: crypto.randomUUID(), items: [{ id: wrap.id, quantity: 1, sauceIds: [sauces[0].id, sauces[0].id], breadQuantity: 0 }], breadQuantity: 0
  }));
  assert.equal(duplicateSauce.response.status, 400);
});

test('postcode allowlisting protects delivery, is staff-managed, and persists across restarts', async () => {
  const appPort = await freePort();
  const appUrl = `http://127.0.0.1:${appPort}`;
  const dbPath = path.join(tempRoot, 'postcode-delivery.sqlite');
  const env = {
    ...process.env,
    PORT: String(appPort),
    DB_PATH: dbPath,
    UPLOAD_DIR: path.join(tempRoot, 'postcode-delivery-uploads'),
    ORDER_TEST_MODE: 'false',
    NODE_ENV: 'test',
    ADMIN_USERNAME: username,
    ADMIN_PASSWORD: password,
    SMTP_USER: '',
    SMTP_APP_PASSWORD: '',
    RESTAURANT_EMAIL: ''
  };
  let child;
  const start = () => spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root, env, stdio: ['ignore', 'ignore', 'ignore']
  });
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    await new Promise(resolve => {
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
      child.kill('SIGTERM');
    });
  };
  const ready = async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Postcode delivery server exited before becoming ready.');
      try {
        if ((await fetch(`${appUrl}/api/settings/order-mode`)).ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Postcode delivery server did not become ready.');
  };
  const login = async () => {
    const response = await fetch(`${appUrl}/api/auth/login`, jsonOptions('POST', { username, password }));
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const api = (route, body, method = 'POST', cookie = '') => fetch(`${appUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const eligibility = async (postcode, country = 'Netherlands') => {
    const response = await api('/api/delivery/eligibility', { postcode, country });
    return { response, body: await response.json() };
  };
  const createDeliveryOrder = async (item, slot, postcode, extras = {}) => api('/api/orders', {
    requestId: crypto.randomUUID(),
    customerName: 'Postcode Integration Test',
    phone: '+31612345678',
    email: 'postcode-test@example.invalid',
    type: 'delivery',
    deliveryAddress: {
      street: 'Teststraat',
      houseNumber: '10',
      postcode,
      city: 'Maastricht',
      country: 'Netherlands'
    },
    orderDate: slot.date,
    orderTime: slot.time,
    paymentMethod: 'cash',
    items: [{ id: item.id, quantity: Math.max(2, Math.ceil(2000 / item.price_cents)), sauceIds: [], breadQuantity: 0 }],
    breadQuantity: 0,
    ...extras
  });
  try {
    child = start();
    await ready();
    const unauthenticatedList = await api('/api/admin/delivery-postcodes', undefined, 'GET');
    assert.equal(unauthenticatedList.status, 401, 'postcode list management requires staff login');
    const unauthenticatedAdd = await api('/api/admin/delivery-postcodes', { postcode: '6217 CT', country: 'Netherlands' });
    assert.equal(unauthenticatedAdd.status, 401, 'unauthorized users cannot add delivery postcodes');
    const unauthenticatedRemove = await api('/api/admin/delivery-postcodes', { postcode: '6217 CT', country: 'Netherlands' }, 'DELETE');
    assert.equal(unauthenticatedRemove.status, 401, 'unauthorized users cannot remove delivery postcodes');
    const defaultDutchPostcode = await eligibility('6217 CT');
    assert.equal(defaultDutchPostcode.response.status, 200);
    assert.equal(defaultDutchPostcode.body.available, true, 'the default Dutch postcode prefix approves matching postcodes');
    const defaultBelgianPostcode = await eligibility('3620', 'Belgium');
    assert.equal(defaultBelgianPostcode.body.available, true, 'the default Belgian list includes nearby postcode areas');
    const outsideDefaultArea = await eligibility('6301 AB');
    assert.equal(outsideDefaultArea.body.available, false, 'postcodes outside the default list remain unavailable');

    const menuResponse = await fetch(`${appUrl}/api/menu`).then(response => response.json());
    const item = menuResponse.items.find(menuItem => menuItem.category === 'kebab');
    const deliverySlots = await fetch(`${appUrl}/api/order-slots?type=delivery`).then(response => response.json());
    assert(item && deliverySlots.slots.length, 'test menu and delivery slots are available');
    const rejectedOutsideDefaultArea = await createDeliveryOrder(item, deliverySlots.slots[0], '6301 AB', {
      approved: true, deliveryApproved: true, postcodeApproved: true
    });
    assert.equal(rejectedOutsideDefaultArea.status, 422, 'direct API approval flags cannot bypass the server postcode list');
    assert.match((await rejectedOutsideDefaultArea.json()).error, /do not deliver to this postcode/i);

    const missingPostcode = await eligibility('');
    assert.equal(missingPostcode.response.status, 400);
    const malformedPostcode = await eligibility('12 34 AB');
    assert.equal(malformedPostcode.response.status, 400);
    const malformedBelgianPostcode = await eligibility('ABCD', 'Belgium');
    assert.equal(malformedBelgianPostcode.response.status, 400);

    let cookie = await login();
    const initiallyEmpty = await api('/api/admin/delivery-postcodes', undefined, 'GET', cookie);
    const defaultPostcodes = (await initiallyEmpty.json()).postcodes;
    assert(defaultPostcodes.some(entry => entry.country === 'Netherlands' && entry.postcode === '6217'));
    assert(defaultPostcodes.some(entry => entry.country === 'Belgium' && entry.postcode === '3620'));
    for (const entry of defaultPostcodes) {
      const removed = await api('/api/admin/delivery-postcodes', entry, 'DELETE', cookie);
      assert.equal(removed.status, 200, 'staff can remove seeded postcode entries');
    }
    assert.deepEqual((await (await api('/api/admin/delivery-postcodes', undefined, 'GET', cookie)).json()).postcodes, []);
    const noPostcodes = await eligibility('6217 CT');
    assert.equal(noPostcodes.body.available, false, 'an explicitly emptied list stays empty');
    assert.match(noPostcodes.body.message, /no delivery postcodes have been configured/i);
    const rejectedWithoutConfiguration = await createDeliveryOrder(item, deliverySlots.slots[0], '6217 CT', {
      approved: true, deliveryApproved: true, postcodeApproved: true
    });
    assert.equal(rejectedWithoutConfiguration.status, 422, 'direct API approval flags cannot bypass an empty server list');
    assert.match((await rejectedWithoutConfiguration.json()).error, /no delivery postcodes have been configured/i);
    const malformedAdd = await api('/api/admin/delivery-postcodes', { postcode: '12 34 AB', country: 'Netherlands' }, 'POST', cookie);
    assert.equal(malformedAdd.status, 400, 'dashboard API rejects malformed postcodes');
    const prefixAdded = await api('/api/admin/delivery-postcodes', { postcode: ' 6217 ', country: 'netherlands' }, 'POST', cookie);
    assert.equal(prefixAdded.status, 201, 'staff can add a four-digit Dutch postcode prefix');
    assert.deepEqual((await prefixAdded.json()).postcodes, [{ postcode: '6217', country: 'Netherlands' }]);
    assert.equal((await eligibility('6217 AB')).body.available, true, 'a Dutch prefix approves all postcodes starting with it');
    assert.equal((await eligibility('6218 AB')).body.available, false, 'a Dutch prefix does not approve a different area');
    const prefixRemoved = await api('/api/admin/delivery-postcodes', { postcode: '6217', country: 'Netherlands' }, 'DELETE', cookie);
    assert.equal(prefixRemoved.status, 200, 'staff can remove a Dutch postcode prefix');
    const added = await api('/api/admin/delivery-postcodes', { postcode: ' 6217ct ', country: 'netherlands' }, 'POST', cookie);
    assert.equal(added.status, 201);
    assert.deepEqual((await added.json()).postcodes, [{ postcode: '6217 CT', country: 'Netherlands' }], 'saved postcode is normalized');
    const unauthorizedRemoveAfterAdd = await api('/api/admin/delivery-postcodes', { postcode: '6217 CT', country: 'Netherlands' }, 'DELETE');
    assert.equal(unauthorizedRemoveAfterAdd.status, 401, 'unauthorized removal leaves the approved list protected');
    const duplicate = await api('/api/admin/delivery-postcodes', { postcode: '6217 CT', country: 'Netherlands' }, 'POST', cookie);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).added, false);

    const normalizedEligibility = await eligibility(' 6217ct ');
    assert.equal(normalizedEligibility.response.status, 200);
    assert.equal(normalizedEligibility.body.available, true, 'spacing and letter case normalize consistently');
    const unapprovedEligibility = await eligibility('6218 AB');
    assert.equal(unapprovedEligibility.response.status, 200);
    assert.equal(unapprovedEligibility.body.available, false);
    const wrongCountryEligibility = await eligibility('6217', 'Belgium');
    assert.equal(wrongCountryEligibility.body.available, false, 'a postcode approval is country-specific');

    const closed = await api('/api/admin/settings/delivery', { open: false }, 'PATCH', cookie);
    assert.equal(closed.status, 200);
    const closedEligibility = await eligibility('6217 CT');
    assert.equal(closedEligibility.body.available, false, 'postcode approval does not override the existing delivery switch');
    const opened = await api('/api/admin/settings/delivery', { open: true }, 'PATCH', cookie);
    assert.equal(opened.status, 200);

    const approvedOrder = await createDeliveryOrder(item, deliverySlots.slots[0], ' 6217ct ');
    assert.equal(approvedOrder.status, 201, 'server accepts a directly submitted approved postcode after normalization');
    const approvedOrderResult = await approvedOrder.json();
    const savedDb = new Database(dbPath, { readonly: true });
    const savedOrder = savedDb.prepare('SELECT total_cents, postcode FROM orders WHERE id = ?').get(approvedOrderResult.orderId);
    assert.equal(savedOrder.postcode, '6217 CT');
    assert.equal(savedOrder.total_cents, item.price_cents * Math.max(2, Math.ceil(2000 / item.price_cents)) + 300, 'the €3 delivery fee remains unchanged');
    savedDb.close();

    const rejectedUnapproved = await createDeliveryOrder(item, deliverySlots.slots[0], '6218 AB', {
      approved: true, deliveryApproved: true, postcodeApproved: true
    });
    assert.equal(rejectedUnapproved.status, 422, 'direct API requests cannot forge postcode approval');
    assert.match((await rejectedUnapproved.json()).error, /do not deliver to this postcode/i);
    const noPostcodeOrder = await createDeliveryOrder(item, deliverySlots.slots[0], '');
    assert.equal(noPostcodeOrder.status, 400, 'direct requests with a missing postcode are rejected');
    const malformedOrder = await createDeliveryOrder(item, deliverySlots.slots[0], '12 34 AB');
    assert.equal(malformedOrder.status, 400, 'direct requests with a malformed postcode are rejected');

    const pickupSlots = await fetch(`${appUrl}/api/order-slots?type=pickup`).then(response => response.json());
    const takeaway = await api('/api/orders', {
      requestId: crypto.randomUUID(),
      customerName: 'Postcode Takeaway Test',
      phone: '+31612345678',
      email: 'takeaway-test@example.invalid',
      type: 'pickup',
      orderDate: pickupSlots.slots[0].date,
      orderTime: pickupSlots.slots[0].time,
      paymentMethod: 'cash',
      items: [{ id: item.id, quantity: 1, sauceIds: [], breadQuantity: 0 }],
      breadQuantity: 0
    });
    assert.equal(takeaway.status, 201, 'takeaway orders remain independent of postcode configuration');

    const checkoutSource = await fetch(`${appUrl}/checkout.html`).then(response => response.text());
    assert.match(checkoutSource, /Delivery availability is checked by postcode area/);
    assert.match(checkoutSource, /\/api\/delivery\/eligibility/);
    assert.doesNotMatch(checkoutSource, /\/api\/delivery\/zone|verificationToken|distanceKm/i, 'checkout no longer uses the distance-verification flow');

    await stop();
    child = start();
    await ready();
    cookie = await login();
    const persisted = await api('/api/admin/delivery-postcodes', undefined, 'GET', cookie);
    assert.deepEqual((await persisted.json()).postcodes, [{ postcode: '6217 CT', country: 'Netherlands' }], 'postcode additions survive a server restart');
    const removed = await api('/api/admin/delivery-postcodes', { postcode: '6217ct', country: 'Netherlands' }, 'DELETE', cookie);
    assert.equal(removed.status, 200);
    assert.deepEqual((await removed.json()).postcodes, []);
    const removedEligibility = await eligibility('6217 CT');
    assert.equal(removedEligibility.body.available, false);

    await stop();
    child = start();
    await ready();
    cookie = await login();
    const afterRemovalRestart = await api('/api/admin/delivery-postcodes', undefined, 'GET', cookie);
    assert.deepEqual((await afterRemovalRestart.json()).postcodes, [], 'postcode removals also survive a server restart');
  } finally {
    await stop();
  }
});

test('ASAP delivery uses the earliest available slot and keeps its lead time', async () => {
  const slots = await request('/api/order-slots?type=delivery');
  assert.equal(slots.response.status, 200);
  assert.equal(slots.body.asap, true);
  const requestId = crypto.randomUUID();
  const order = await request('/api/orders', jsonOptions('POST', {
    requestId,
    customerName: 'ASAP Integration Delivery',
    phone: '+31612345678',
    email: 'asap-delivery@example.invalid',
    type: 'delivery',
    orderDate: slots.body.today,
    orderTime: 'asap',
    paymentMethod: 'cash',
    deliveryAddress: { street: 'Teststraat', houseNumber: '10', postcode: '6217 CT', city: 'Maastricht', country: 'Netherlands' },
    items: [{ id: wrap.id, quantity: 2, sauceIds: [], breadQuantity: 0 }],
    breadQuantity: 0
  }));
  assert.equal(order.response.status, 201, JSON.stringify(order.body));
  const db = new Database(path.join(tempRoot, 'audit-test.sqlite'), { readonly: true });
  const saved = db.prepare('SELECT order_date, order_time FROM orders WHERE client_request_id = ?').get(requestId);
  db.close();
  const savedSlot = slots.body.slots.find(slot => slot.date === saved.order_date && slot.time === saved.order_time);
  assert(savedSlot, 'ASAP delivery is assigned to an available scheduled slot');
  assert(new Date(savedSlot.instant).getTime() >= new Date(slots.body.serverNow).getTime() + 30 * 60000);
});

test('staff APIs reject anonymous writes and allow authenticated order management', async () => {
  const anonymous = await request('/api/admin/orders');
  assert.equal(anonymous.response.status, 401);
  const login = await fetch(`${baseUrl}/api/auth/login`, jsonOptions('POST', { username, password }));
  assert.equal(login.status, 200);
  adminCookie = login.headers.get('set-cookie').split(';')[0];
  const list = await request('/api/admin/orders', { headers: { Cookie: adminCookie } });
  assert.equal(list.response.status, 200);
  assert(list.body.orders.some(order => order.customer_name === 'Integration Pickup' && order.test_mode));
  const id = list.body.orders.find(order => order.customer_name === 'Integration Pickup').id;
  const update = await request(`/api/admin/orders/${id}`, jsonOptions('PATCH', { status: 'accepted' }, adminCookie));
  assert.equal(update.response.status, 200);
});

test('sold-out menu items remain visible but cannot be ordered', async () => {
  const updated = await request(`/api/admin/menu/${drink.id}`, jsonOptions('PATCH', { available: false }, adminCookie));
  assert.equal(updated.response.status, 200);
  try {
    const publicMenu = await request('/api/menu');
    assert.equal(publicMenu.response.status, 200);
    const soldOut = publicMenu.body.items.find(item => item.id === drink.id);
    assert(soldOut, 'sold-out items remain listed for customers');
    assert.equal(Boolean(soldOut.available), false);
    assert.equal(publicMenu.response.headers.get('cache-control'), 'no-cache');

    const rejectedOrder = await request('/api/orders', jsonOptions('POST', {
      requestId: crypto.randomUUID(),
      customerName: 'Sold Out Integration',
      phone: '+31612345678',
      email: 'sold-out@example.invalid',
      type: 'pickup',
      orderDate: pickupSlot.date,
      orderTime: pickupSlot.time,
      paymentMethod: 'cash',
      items: [{ id: drink.id, quantity: 1, sauceIds: [], breadQuantity: 0 }],
      breadQuantity: 0
    }));
    assert.equal(rejectedOrder.response.status, 409);
    assert.match(rejectedOrder.body.error, /sold out or not available/i);
  } finally {
    const restored = await request(`/api/admin/menu/${drink.id}`, jsonOptions('PATCH', { available: true }, adminCookie));
    assert.equal(restored.response.status, 200);
  }
});

test('staff records identify returning customers by matching phone and name, not email or address', async () => {
  const db = new Database(path.join(tempRoot, 'audit-test.sqlite'));
  const insertOrder = db.prepare(`INSERT INTO orders
    (customer_name, phone, email, type, address, items_json, total_cents, order_time, order_date, client_request_id, created_at)
    VALUES (?, ?, ?, ?, ?, '[]', 1000, '18:00', ?, ?, ?)`);
  const firstId = insertOrder.run('History Guest', '+31 (6) 9876-5432', 'old@example.invalid', 'delivery', 'Same Street 5, Maastricht', pickupSlot.date, crypto.randomUUID(), '2026-10-20 12:00:00').lastInsertRowid;
  const returningId = insertOrder.run('  history   guest ', '06 9876 5432', 'different@example.invalid', 'delivery', 'Changed Address 10, Maastricht', pickupSlot.date, crypto.randomUUID(), '2026-10-21 12:00:00').lastInsertRowid;
  const ambiguousId = insertOrder.run('Different Person', '+31698765432', 'another@example.invalid', 'pickup', '', pickupSlot.date, crypto.randomUUID(), '2026-10-22 12:00:00').lastInsertRowid;
  const sameAddressId = insertOrder.run('Household Member', '+31611112222', 'household@example.invalid', 'delivery', 'Same Street 5, Maastricht', pickupSlot.date, crypto.randomUUID(), '2026-10-23 12:00:00').lastInsertRowid;
  const reservationId = db.prepare(`INSERT INTO reservations (name, email, phone, reservation_date, reservation_time, guests, created_at)
    VALUES (?, ?, ?, ?, '19:00', 2, ?)`).run('History Guest', 'reservation@example.invalid', '+31698765432', pickupSlot.date, '2026-10-24 12:00:00').lastInsertRowid;
  db.close();

  const orders = await request('/api/admin/orders', { headers: { Cookie: adminCookie } });
  assert.equal(orders.response.status, 200);
  const byId = new Map(orders.body.orders.map(order => [order.id, order]));
  assert.equal(byId.get(firstId).customer_type, 'first-time');
  assert.equal(byId.get(returningId).customer_type, 'returning', 'a changed email and address do not hide a matching customer');
  assert.equal(byId.get(ambiguousId).customer_type, 'unknown', 'a different name using a known phone is ambiguous');
  assert.equal(byId.get(sameAddressId).customer_type, 'first-time', 'a shared delivery address does not merge different people');

  const reservations = await request('/api/admin/reservations', { headers: { Cookie: adminCookie } });
  assert.equal(reservations.response.status, 200);
  assert.equal(reservations.body.reservations.find(item => item.id === reservationId).customer_type, 'returning');
});

test('weekly menu dishes have the correct availability and Dutch day descriptions', async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, jsonOptions('POST', { username, password }));
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await request('/api/admin/menu', { headers: { Cookie: cookie } });
  assert.equal(response.response.status, 200);
  const expectedSchedules = {
    'baghali polo ba goosht': ['friday'],
    'adas polo': ['thursday'],
    'loobia polo': ['saturday'],
    'zereshk polo ba morgh': ['sunday'],
    'khoresh fesenjoon': ['wednesday']
  };
  const dutchDays = {
    friday: 'vrijdag',
    thursday: 'donderdag',
    saturday: 'zaterdag',
    sunday: 'zondag',
    wednesday: 'woensdag'
  };
  for (const [name, days] of Object.entries(expectedSchedules)) {
    const item = response.body.items.find(entry => entry.name === name);
    assert(item, `admin menu includes ${name}`);
    assert.deepEqual(JSON.parse(item.available_days), days, `${name} is only available on the requested day`);
    assert(item.description.startsWith(`Alleen verkrijgbaar op ${dutchDays[days[0]]}. `), `${name} description names the correct day`);
  }
  const publicMenu = await request('/api/menu');
  assert.equal(publicMenu.response.status, 200);
  assert.match(publicMenu.body.today, /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  for (const [name, days] of Object.entries(expectedSchedules)) {
    const item = publicMenu.body.items.find(entry => entry.name === name);
    assert(item, `${name} retains its schedule for date-based order validation`);
    assert.deepEqual(JSON.parse(item.available_days), days, `${name} exposes its ordering schedule`);
  }
});

test('changing a dish weekday in menu management updates the public menu schedule', async () => {
  try {
    const updated = await request(`/api/admin/menu/${baghali.id}`, jsonOptions('PATCH', { availableDays: ['thursday'] }, adminCookie));
    assert.equal(updated.response.status, 200);
    assert.deepEqual(JSON.parse(updated.body.item.available_days), ['thursday']);

    const publicMenu = await request('/api/menu');
    assert.equal(publicMenu.response.status, 200);
    const publicItem = publicMenu.body.items.find(item => item.id === baghali.id);
    assert(publicItem, 'scheduled items remain available for future-date ordering');
    assert.deepEqual(JSON.parse(publicItem.available_days), ['thursday'], 'the public menu receives only the newly selected weekday');
  } finally {
    const restored = await request(`/api/admin/menu/${baghali.id}`, jsonOptions('PATCH', { availableDays: ['friday'] }, adminCookie));
    assert.equal(restored.response.status, 200);
  }
});

test('scheduled dishes are accepted only for an available date in the next three weeks', async () => {
  const slots = (await request('/api/order-slots?type=pickup')).body.slots;
  const weekdayForSlot = slot => new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Amsterdam', weekday: 'long' })
    .format(new Date(`${slot.date}T12:00:00Z`)).toLowerCase();
  const availableSlot = slots.find(slot => weekdayForSlot(slot) === 'friday');
  const unavailableSlot = slots.find(slot => weekdayForSlot(slot) !== 'friday');
  assert(availableSlot && unavailableSlot, 'three-week test schedule includes available and unavailable weekdays');
  const createOrder = (slot, requestId) => request('/api/orders', jsonOptions('POST', {
    requestId,
    customerName: 'Scheduled Integration',
    phone: '+31612345678',
    email: 'scheduled@example.invalid',
    type: 'pickup',
    orderDate: slot.date,
    orderTime: slot.time,
    paymentMethod: 'cash',
    items: [{ id: baghali.id, quantity: 1, sauceIds: [], breadQuantity: 0 }],
    breadQuantity: 0
  }));
  const accepted = await createOrder(availableSlot, crypto.randomUUID());
  assert.equal(accepted.response.status, 201, JSON.stringify(accepted.body));
  const rejected = await createOrder(unavailableSlot, crypto.randomUUID());
  assert.equal(rejected.response.status, 409);
  assert.match(rejected.body.error, /not available on the selected order date/i);

  const beyondRange = new Date(`${slots.at(-1).date}T12:00:00Z`);
  beyondRange.setUTCDate(beyondRange.getUTCDate() + 1);
  const outsideWindow = await createOrder({ date: beyondRange.toISOString().slice(0, 10), time: slots.at(-1).time }, crypto.randomUUID());
  assert.equal(outsideWindow.response.status, 400);
  assert.match(outsideWindow.body.error, /within the next 21 days/i);
});

test('reservation requests deduplicate and can be confirmed by staff', async () => {
  const hours = await request('/api/settings/business-hours');
  const openDay = new Set(['wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
  let date = '';
  for (let offset = 1; offset <= 14; offset++) {
    const next = new Date(); next.setUTCDate(next.getUTCDate() + offset);
    const value = next.toISOString().slice(0, 10);
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Amsterdam', weekday: 'long' }).format(new Date(`${value}T12:00:00Z`)).toLowerCase();
    if (openDay.has(weekday) && hours.body.hours[weekday]?.reservations) { date = value; break; }
  }
  assert(date, 'an open reservation date exists in the next two weeks');
  const payload = { requestId: crypto.randomUUID(), name: 'Integration Guest', email: 'guest@example.invalid', phone: '+31612345678', date, time: '17:00', guests: 2, purpose: 'dinner', notes: 'isolated' };
  const first = await request('/api/reservations', jsonOptions('POST', payload));
  assert.equal(first.response.status, 201, JSON.stringify(first.body));
  const duplicate = await request('/api/reservations', jsonOptions('POST', payload));
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.reservationId, first.body.reservationId);
  const newer = await request('/api/reservations', jsonOptions('POST', { ...payload, requestId: crypto.randomUUID(), name: 'Newer Integration Guest' }));
  assert.equal(newer.response.status, 201, JSON.stringify(newer.body));
  const reservations = await request('/api/admin/reservations', { headers: { Cookie: adminCookie } });
  assert.equal(reservations.response.status, 200);
  assert(reservations.body.reservations.findIndex(item => item.id === newer.body.reservationId) < reservations.body.reservations.findIndex(item => item.id === first.body.reservationId), 'newest reservation request is listed first');
  const confirmed = await request(`/api/admin/reservations/${first.body.reservationId}`, jsonOptions('PATCH', { status: 'confirmed' }, adminCookie));
  assert.equal(confirmed.response.status, 200);
});

test('menu image upload validates content in the temporary upload directory', async () => {
  const invalid = await request('/api/admin/menu-image', jsonOptions('POST', { dataUrl: 'data:image/png;base64,AAAA' }, adminCookie));
  assert.equal(invalid.response.status, 400);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJgAAAABJRU5ErkJggg==', 'base64');
  const valid = await request('/api/admin/menu-image', jsonOptions('POST', { dataUrl: `data:image/png;base64,${png.toString('base64')}` }, adminCookie));
  assert.equal(valid.response.status, 201, JSON.stringify(valid.body));
  assert.match(valid.body.image, /^\/uploads\/menu\//);
});
