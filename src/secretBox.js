const crypto = require('node:crypto');

function getEncryptionKey(environment = process.env) {
  const configuredKey = environment.DOCTOR_CONFIG_ENCRYPTION_KEY;
  if (!configuredKey) throw new Error('DOCTOR_CONFIG_ENCRYPTION_KEY is not configured');

  const key = /^[a-f0-9]{64}$/i.test(configuredKey)
    ? Buffer.from(configuredKey, 'hex')
    : Buffer.from(configuredKey, 'base64');
  if (key.length !== 32) throw new Error('DOCTOR_CONFIG_ENCRYPTION_KEY must encode exactly 32 bytes');
  return key;
}

function hasValidEncryptionKey(environment = process.env) {
  try {
    getEncryptionKey(environment);
    return true;
  } catch {
    return false;
  }
}

function encryptJson(value, environment = process.env) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(environment), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final()
  ]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

function decryptJson(encodedValue, environment = process.env) {
  const [ivValue, tagValue, ciphertextValue, extra] = String(encodedValue || '').split('.');
  if (!ivValue || !tagValue || !ciphertextValue || extra !== undefined) {
    throw new Error('Encrypted doctor credentials have an invalid format');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(environment), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

module.exports = { decryptJson, encryptJson, hasValidEncryptionKey };