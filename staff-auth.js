const crypto = require('node:crypto');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (typeof storedHash !== 'string' || !storedHash.includes(':')) return false;
  const [salt, expected] = storedHash.split(':');
  if (!salt || !/^[\da-f]{128}$/i.test(expected || '')) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

function resetStaffPassword(db, username, password) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) throw new Error('A staff username is required.');
  if (typeof password !== 'string' || password.length < 16) throw new Error('Use a password with at least 16 characters.');
  const staff = db.prepare('SELECT id FROM staff_users WHERE username = ?').get(normalizedUsername);
  if (!staff) throw new Error('No staff account matches that username.');
  db.prepare('UPDATE staff_users SET password_hash = ? WHERE id = ?').run(hashPassword(password), staff.id);
}

module.exports = { hashPassword, verifyPassword, resetStaffPassword };
