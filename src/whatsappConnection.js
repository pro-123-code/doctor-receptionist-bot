// Pure decisions for the WhatsApp socket lifecycle.
//
// A reconnect loop is not one bug. WhatsApp closes a socket for reasons that need
// opposite responses: a stale session must be deleted and paired again, while a
// competing connection must be left alone long enough for the other process to
// exit. Keeping the policy here means it can be tested without a live socket, a
// phone, or a database.

const SESSION_EXPIRED_CODES = new Set([
  401, // loggedOut
  403, // forbidden
  411, // multideviceMismatch
  500 // badSession
]);

const TRANSIENT_BACKOFF_MS = [3000, 5000, 10000, 20000, 30000, 60000];

function normalizeStatusCode(statusCode) {
  const parsed = Number(statusCode);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSessionExpiredStatus(statusCode) {
  const code = normalizeStatusCode(statusCode);
  return code !== null && SESSION_EXPIRED_CODES.has(code);
}

function isConflictStatus(statusCode) {
  return normalizeStatusCode(statusCode) === 440;
}

// A session that WhatsApp refuses will never heal by reconnecting. It has to be
// wiped so the next attempt can show a fresh QR code instead of looping forever.
function shouldWipeSession(statusCode) {
  return isSessionExpiredStatus(statusCode);
}

function reconnectDelayMs(attempt, statusCode) {
  const code = normalizeStatusCode(statusCode);
  // After a QR scan Baileys asks for a restart; this is normal pairing, not an
  // error. Reconnect quickly, but after the credentials have been saved.
  if (code === 515) return 1000;
  // A wiped session is useless; show a new QR as soon as the wipe finishes.
  if (isSessionExpiredStatus(code)) return 1000;
  // Another process still holds the same credentials. Back off long enough for
  // a rolling deploy to finish instead of two sockets kicking each other.
  if (code === 440) return 30000;
  const index = Math.min(Math.max((Number(attempt) || 1) - 1, 0), TRANSIENT_BACKOFF_MS.length - 1);
  return TRANSIENT_BACKOFF_MS[index];
}

function describeDisconnect(statusCode) {
  switch (normalizeStatusCode(statusCode)) {
    case 401: return 'WhatsApp logged out this device';
    case 403: return 'WhatsApp blocked this device';
    case 411: return 'This WhatsApp device session is incompatible';
    case 500: return 'WhatsApp rejected the stored session';
    case 440: return 'Another connection is using this WhatsApp session';
    case 515: return 'WhatsApp asked the connection to restart';
    case 408: return 'The connection timed out';
    case 428: return 'The connection closed';
    case 503: return 'WhatsApp is temporarily unavailable';
    default: return statusCode
      ? `WhatsApp closed the connection (${statusCode})`
      : 'The connection closed';
  }
}

module.exports = {
  TRANSIENT_BACKOFF_MS,
  describeDisconnect,
  isConflictStatus,
  isSessionExpiredStatus,
  reconnectDelayMs,
  shouldWipeSession
};
