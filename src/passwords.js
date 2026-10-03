const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const keyLength = 64;
const scryptOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new Error('Password must be between 12 and 256 characters');
  }
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(password, salt, keyLength, scryptOptions);
  return `scrypt$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
}

async function verifyPassword(password, encodedHash) {
  if (typeof password !== 'string' || typeof encodedHash !== 'string') return false;
  const [algorithm, saltValue, keyValue, extra] = encodedHash.split('$');
  if (algorithm !== 'scrypt' || !saltValue || !keyValue || extra !== undefined) return false;

  try {
    const salt = Buffer.from(saltValue, 'base64url');
    const expectedKey = Buffer.from(keyValue, 'base64url');
    if (salt.length !== 16 || expectedKey.length !== keyLength) return false;
    const actualKey = await scrypt(password, salt, keyLength, scryptOptions);
    return crypto.timingSafeEqual(actualKey, expectedKey);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };