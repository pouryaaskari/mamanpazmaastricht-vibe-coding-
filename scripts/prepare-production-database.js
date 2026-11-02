const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const sourcePath = path.resolve(process.env.PRODUCTION_SOURCE_DB_PATH || path.join(root, 'mamanpaz.sqlite'));
const outputPath = path.resolve(process.env.PRODUCTION_DB_OUTPUT_PATH || path.join(root, 'mamanpaz-production.sqlite'));
const menuFields = [
  'id', 'name', 'name_fa', 'description', 'price_cents', 'category', 'image',
  'available', 'available_days', 'sort_order', 'created_at', 'updated_at'
];
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const dutchWeekdays = {
  monday: 'maandag', tuesday: 'dinsdag', wednesday: 'woensdag', thursday: 'donderdag',
  friday: 'vrijdag', saturday: 'zaterdag', sunday: 'zondag'
};

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function startSchemaInitializer(databasePath, uploadPath) {
  const port = await availablePort();
  const env = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'development',
    ORDER_TEST_MODE: 'true',
    DB_PATH: path.join(path.dirname(databasePath), 'unused-production.sqlite'),
    ORDER_TEST_DB_PATH: databasePath,
    UPLOAD_DIR: uploadPath,
    ADMIN_USERNAME: '',
    ADMIN_PASSWORD: '',
    SMTP_USER: '',
    SMTP_APP_PASSWORD: ''
  };
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-20000); });
  child.stderr.on('data', chunk => { output = `${output}${chunk}`.slice(-20000); });

  try {
    const deadline = Date.now() + 20000;
    let lastConnectionError = 'no successful response from the menu endpoint';
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Schema initializer exited before becoming ready:\n${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/menu`);
        if (response.ok) return child;
        lastConnectionError = `menu endpoint returned HTTP ${response.status}`;
      } catch (error) {
        lastConnectionError = error.message;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Schema initializer did not become ready (${lastConnectionError}):\n${output}`);
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  await new Promise(resolve => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function assertOpeningHours(rawValue) {
  let hours;
  try {
    hours = JSON.parse(rawValue);
  } catch (error) {
    throw new Error(`The source database has invalid business_hours JSON: ${error.message}`, { cause: error });
  }
  for (const day of weekdays) {
    const open = !['monday', 'tuesday'].includes(day);
    const settings = hours[day];
    assert(settings, `business_hours is missing ${day}`);
    assert.equal(settings.open, open, `${day} open status`);
    assert.equal(settings.orders, open, `${day} ordering status`);
    assert.equal(settings.reservations, open, `${day} reservation status`);
    assert.equal(settings.opens, '16:30', `${day} opening time`);
    assert.equal(settings.closes, '22:00', `${day} closing time`);
  }
  return rawValue;
}

function prepareConfiguration(database, sourceMenu, businessHours) {
  const baghali = sourceMenu.filter(item => /baghali polo ba (gosht|goosht)/i.test(item.name));
  assert.equal(baghali.length, 1, 'source must contain exactly one Baghali Polo ba Gosht item');

  const replaceMenu = database.prepare(`
    INSERT INTO menu_items (${menuFields.map(field => `"${field}"`).join(', ')})
    VALUES (${menuFields.map(() => '?').join(', ')})
  `);
  database.transaction(() => {
    database.prepare('DELETE FROM menu_items').run();
    for (const item of sourceMenu) {
      const row = { ...item };
      if (/baghali polo ba (gosht|goosht)/i.test(row.name)) {
        row.available_days = JSON.stringify(['friday']);
        const description = row.description
          .replace(/^Alleen verkrijgbaar op [^.]+\.\s*/i, '')
          .replace(/^Alleen op [^!]+!\s*/i, '')
          .trim();
        row.description = `Alleen verkrijgbaar op ${dutchWeekdays.friday}. ${description}`;
      }
      replaceMenu.run(...menuFields.map(field => row[field]));
    }
    database.prepare(`
      INSERT INTO restaurant_settings (key, value) VALUES ('business_hours', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(businessHours);
    database.prepare(`
      INSERT INTO restaurant_settings (key, value) VALUES ('delivery', 'open')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
  })();
}

function verifyPreparedDatabase(database, expectedMenu, expectedHours) {
  const tables = new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name));
  for (const table of [
    'menu_items', 'restaurant_settings', 'staff_users', 'orders',
    'reservations', 'event_inquiries', 'notification_outbox', 'test_notification_log'
  ]) assert(tables.has(table), `initialized schema is missing ${table}`);

  const actualMenu = database.prepare(`SELECT ${menuFields.map(field => `"${field}"`).join(', ')} FROM menu_items ORDER BY id`).all();
  assert.equal(actualMenu.length, 43, 'production menu must contain all 43 items');
  const expectedById = new Map(expectedMenu.map(item => [item.id, item]));
  for (const actual of actualMenu) {
    const expected = expectedById.get(actual.id);
    assert(expected, `unexpected menu item id ${actual.id}`);
    assert.deepEqual(actual, expected, `menu configuration mismatch for ${actual.name}`);
  }
  assert.equal(
    database.prepare("SELECT value FROM restaurant_settings WHERE key = 'business_hours'").get()?.value,
    expectedHours,
    'opening hours are preserved'
  );
  assert.equal(database.prepare("SELECT value FROM restaurant_settings WHERE key = 'delivery'").get()?.value, 'open');

  for (const table of ['staff_users', 'orders', 'reservations', 'event_inquiries', 'notification_outbox', 'test_notification_log']) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count, 0, `${table} must start empty`);
  }
  assert.deepEqual(database.pragma('integrity_check').map(row => row.integrity_check), ['ok']);
}

async function main() {
  if (sourcePath === outputPath) throw new Error('Production source and output paths must be different.');
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`Source SQLite database does not exist or is not a file: ${sourcePath}`);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (fs.existsSync(outputPath)) throw new Error(`Refusing to overwrite an existing production database: ${outputPath}`);

  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  source.pragma('query_only = ON');
  let sourceMenu;
  let businessHours;
  try {
    const sourceColumns = new Set(source.pragma('table_info(menu_items)').map(column => column.name));
    for (const field of menuFields) assert(sourceColumns.has(field), `source menu schema is missing ${field}`);
    sourceMenu = source.prepare(`SELECT ${menuFields.map(field => `"${field}"`).join(', ')} FROM menu_items ORDER BY id`).all();
    assert.equal(sourceMenu.length, 43, 'source database must contain exactly 43 menu items');
    businessHours = assertOpeningHours(
      source.prepare("SELECT value FROM restaurant_settings WHERE key = 'business_hours'").get()?.value
    );
    for (const item of sourceMenu) {
      assert(Number.isInteger(item.price_cents) && item.price_cents >= 0, `invalid price for ${item.name}`);
      const days = JSON.parse(item.available_days || '[]');
      assert(Array.isArray(days) && days.every(day => weekdays.includes(day)), `invalid weekday restrictions for ${item.name}`);
    }
  } finally {
    source.close();
  }

  const stagingDirectory = fs.mkdtempSync(path.join(path.dirname(outputPath), '.mamanpaz-production-stage-'));
  const stagingDatabasePath = path.join(stagingDirectory, 'mamanpaz.sqlite');
  let initializer;
  let database;
  try {
    initializer = await startSchemaInitializer(stagingDatabasePath, path.join(stagingDirectory, 'uploads'));
    await stopChild(initializer);
    initializer = null;

    database = new Database(stagingDatabasePath);
    prepareConfiguration(database, sourceMenu, businessHours);

    const expectedMenu = sourceMenu.map(item => {
      if (!/baghali polo ba (gosht|goosht)/i.test(item.name)) return item;
      const description = item.description
        .replace(/^Alleen verkrijgbaar op [^.]+\.\s*/i, '')
        .replace(/^Alleen op [^!]+!\s*/i, '')
        .trim();
      return {
        ...item,
        available_days: JSON.stringify(['friday']),
        description: `Alleen verkrijgbaar op ${dutchWeekdays.friday}. ${description}`
      };
    });
    verifyPreparedDatabase(database, expectedMenu, businessHours);
    database.close();
    database = null;

    fs.linkSync(stagingDatabasePath, outputPath);
    fs.chmodSync(outputPath, 0o600);
    console.log(`Created clean production database: ${outputPath}`);
    console.log('Verified: 43 menu items, requested opening hours, delivery enabled, no staff accounts or historical records.');
  } finally {
    database?.close();
    if (initializer) await stopChild(initializer);
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Production database preparation failed: ${error.message}`);
  process.exitCode = 1;
});
