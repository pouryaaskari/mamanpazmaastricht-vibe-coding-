require('dotenv').config();
const readline = require('node:readline');
const path = require('node:path');
const Database = require('better-sqlite3');
const { resetStaffPassword } = require('../staff-auth');

if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
  console.error('Run this command in an interactive terminal so the new password can be entered without echo.');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = prompt => new Promise(resolve => rl.question(prompt, resolve));
const askHidden = prompt => new Promise((resolve, reject) => {
  const input = process.stdin;
  let value = '';
  process.stdout.write(prompt);
  const onData = chunk => {
    for (const char of chunk.toString('utf8')) {
      if (char === '\u0003') { cleanup(); reject(new Error('Cancelled.')); return; }
      if (char === '\r' || char === '\n') { process.stdout.write('\n'); cleanup(); resolve(value); return; }
      if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
      else if (char >= ' ') value += char;
    }
  };
  const cleanup = () => { input.off('data', onData); input.setRawMode(false); };
  input.setRawMode(true);
  input.resume();
  input.on('data', onData);
});

(async () => {
  let db;
  try {
    const username = (await ask('Staff username to update: ')).trim();
    rl.close();
    const password = await askHidden('New password (16+ characters; input hidden): ');
    const confirmation = await askHidden('Confirm new password (input hidden): ');
    if (password !== confirmation) throw new Error('The passwords did not match.');
    const databasePath = path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'mamanpaz.sqlite'));
    db = new Database(databasePath);
    resetStaffPassword(db, username, password);
    console.log('Staff password updated. Restart the web server to invalidate existing sessions.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    db?.close();
    rl.close();
    if (process.stdin.isRaw) process.stdin.setRawMode(false);
  }
})();
