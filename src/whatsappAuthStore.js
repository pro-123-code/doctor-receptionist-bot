// WhatsApp authentication state stored in MongoDB instead of the local filesystem.
//
// useMultiFileAuthState writes the credentials to files, so on a platform whose
// filesystem is wiped on every deploy each clinic has to rescan its QR code. The
// credentials and the Signal keys therefore live in MongoDB, which is already
// persistent and already the system of record for every other clinic setting.
//
// IMPORTANT: this must match Baileys' own contract exactly. AuthenticationState is
// { creds, keys } where `creds` is the live credential OBJECT, not a getter. Baileys
// reads creds.noiseKey / creds.signedIdentityKey / creds.registrationId while it
// builds the socket and mutates the same object as the handshake progresses, then
// emits a partial `creds.update`; the listener is expected to persist the whole
// object. An earlier version of this file passed a { get, set, clear } wrapper as
// `creds` and wrote each partial update over the stored record, which made every
// connection fail during setup and left unusable credentials behind.
const mongoose = require('mongoose');

// Baileys value per store type. 'pre-key' and 'sender-key' must survive a restart
// or the counterpart's message cannot be decrypted, so they have no expiry.
const PERSISTENT_TYPES = new Set(['pre-key', 'sender-key']);
const EXPIRING_TYPES = new Set(['session', 'sender-key-memory', 'app-state-sync-key', 'app-state-sync-version']);

// A record written by a broken or half-finished login can exist but still be
// unusable. These are the fields Baileys touches before it can ever emit a QR code,
// so a record missing any of them is treated as no record at all and replaced.
const REQUIRED_CREDS_FIELDS = ['noiseKey', 'signedIdentityKey', 'signedPreKey', 'registrationId', 'advSecretKey'];

// Baileys is loaded lazily so this module stays testable without the package and so
// a deployment without WhatsApp support does not fail at require time.
function defaultInitAuthCreds() {
  // eslint-disable-next-line global-require
  const baileys = require('@whiskeysockets/baileys');
  return baileys.initAuthCreds();
}

function isBsonBinary(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value._bsontype === 'Binary' &&
    Buffer.isBuffer(value.buffer)
  );
}

function toBuffer(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  // The MongoDB driver returns BSON Binary by default, not a Node Buffer. A
  // stored credential read back this way looks like an object and passes a
  // simple presence check, but Baileys' Noise handshake needs a real Buffer.
  if (isBsonBinary(value)) {
    // Binary.value() respects the logical length when the backing buffer is
    // larger than the stored value.
    return typeof value.value === 'function' ? Buffer.from(value.value()) : Buffer.from(value.buffer);
  }
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return value;
}

// Credentials and Signal keys contain Buffers nested inside plain objects and
// arrays. Mongo round-trips those as BSON Binary, so every level has to be
// revived before Baileys sees it. Objects with a BSON type marker that is not
// Binary (Long, Decimal128, ObjectId) are left alone; Dates too.
function reviveStoredValue(value) {
  if (value === null || value === undefined) return value;
  const buffered = toBuffer(value);
  if (buffered !== value) return buffered;
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(reviveStoredValue);
  if (typeof value !== 'object') return value;
  if (value instanceof Date || value._bsontype) return value;
  const revived = {};
  for (const [key, entry] of Object.entries(value)) {
    revived[key] = reviveStoredValue(entry);
  }
  return revived;
}

// Protobuf instances (app state sync keys) and similar wrappers must be stored as
// plain objects. Buffers expose a toJSON of their own that would corrupt them, so
// they are excluded first.
function toStorable(value) {
  const buffered = toBuffer(value);
  if (buffered !== value) return buffered;
  if (value && typeof value.toJSON === 'function' && !Buffer.isBuffer(value)) {
    try {
      return value.toJSON();
    } catch {
      return value;
    }
  }
  return value;
}

function whatsappAuthSchema() {
  if (mongoose.models.WhatsAppAuthState) return mongoose.models.WhatsAppAuthState;
  const schema = new mongoose.Schema({
    doctorId: { type: String, required: true, index: true },
    storeType: { type: String, required: true },
    storeId: { type: String, default: '' },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, default: null }
  }, { _id: false, minimize: false });
  schema.index({ doctorId: 1, storeType: 1, storeId: 1 }, { unique: true });
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: 'date' } } });
  return mongoose.model('WhatsAppAuthState', schema);
}

function documentId(doctorId, storeType, storeId) {
  return `${doctorId}:${storeType}:${storeId}`;
}

// True only when the stored record has everything a socket needs to start.
function isUsableCreds(creds) {
  if (!creds || typeof creds !== 'object') return false;
  return REQUIRED_CREDS_FIELDS.every((field) => {
    const value = creds[field];
    if (value === null || value === undefined) return false;
    if (typeof value === 'object' && Object.keys(value).length === 0) return false;
    return true;
  });
}

// Builds the Baileys auth state backed by MongoDB for one clinic.
// The model can be supplied so the store can be exercised without a live database,
// and initAuthCreds can be supplied so tests need no copy of Baileys.
async function createMongoAuthState(doctorId, options = {}) {
  const Model = options.Model || whatsappAuthSchema();
  const initAuthCreds = options.initAuthCreds || defaultInitAuthCreds;
  const scoped = { doctorId };

  const storedRow = await Model.findOne({ ...scoped, storeType: 'creds', storeId: '' }).lean();
  // `.lean()` does not cast, so binary fields arrive as BSON Binary. Revive them
  // before isUsableCreds and before the object is handed to Baileys.
  const storedCreds = storedRow ? reviveStoredValue(storedRow.value) : null;
  const hadStoredCreds = isUsableCreds(storedCreds);
  if (storedRow && !hadStoredCreds) {
    // Remove the unusable record so the next save writes a clean one.
    await Model.deleteOne({ ...scoped, storeType: 'creds', storeId: '' });
  }

  // Baileys mutates this object in place; everything below persists the same
  // reference, which is exactly what the file-backed store does.
  const creds = hadStoredCreds ? storedCreds : initAuthCreds();

  const saveCreds = async () => {
    await Model.updateOne(
      { ...scoped, storeType: 'creds', storeId: '' },
      { $set: { value: creds, expiresAt: null } },
      { upsert: true }
    );
  };

  const keys = {
    async get(type, ids) {
      if (!Array.isArray(ids) || ids.length === 0) return {};
      const rows = await Model.find({ ...scoped, storeType: type, storeId: { $in: ids } }).lean();
      const data = {};
      for (const row of rows) {
        if (row.value === null || row.value === undefined) continue;
        // Binary values come back from the driver as BSON Binary. Revive them at
        // every level before Baileys uses them as Signal keys.
        const value = reviveStoredValue(row.value);
        // Baileys round-trips app state sync keys through a protobuf type, so a
        // plain object read back from the database must be revived the same way
        // the file store revives it.
        data[row.storeId] = type === 'app-state-sync-key' ? reviveAppStateKey(value) : value;
      }
      return data;
    },
    async set(data) {
      const operations = [];
      for (const [type, entries] of Object.entries(data || {})) {
        if (!entries || typeof entries !== 'object') continue;
        const expiring = EXPIRING_TYPES.has(type);
        for (const [id, value] of Object.entries(entries)) {
          const filter = { ...scoped, storeType: type, storeId: id };
          if (value === null || value === undefined) {
            // Baileys uses null to mean "this key is gone, delete it".
            operations.push({ deleteOne: { filter } });
            continue;
          }
          operations.push({
            updateOne: {
              filter,
              update: {
                $set: {
                  value: toStorable(value),
                  expiresAt: expiring && !PERSISTENT_TYPES.has(type) ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null
                }
              },
              upsert: true
            }
          });
        }
      }
      if (operations.length) await Model.bulkWrite(operations, { ordered: false });
    },
    async clear() {
      await Model.deleteMany({ ...scoped });
    }
  };

  return {
    // The shape Baileys expects: a live creds object plus a Signal key store.
    state: { creds, keys },
    // Baileys emits a partial update; Object.assign into `creds` happens inside the
    // socket before this listener runs, so the whole object is what must be saved.
    saveCreds,
    // Whether this call found usable credentials, which tells the caller whether the
    // on-disk copy is now redundant and can be cleared.
    hadStoredCreds,
    wipe: async () => {
      await Model.deleteMany({ ...scoped });
    },
    Model
  };
}

// App-state sync keys are stored as plain JSON objects. Rebuild the protobuf type
// after the binary fields inside them have been revived.
function reviveAppStateKey(value) {
  try {
    // eslint-disable-next-line global-require
    const { proto } = require('@whiskeysockets/baileys');
    return proto.Message.AppStateSyncKeyData.fromObject(value);
  } catch {
    return value;
  }
}

// Lets the worker synchronizer discover a MongoDB-backed session after a deploy
// without looking for a creds.json file that MongoDB never writes.
async function hasStoredWhatsAppSession(doctorId, options = {}) {
  const Model = options.Model || whatsappAuthSchema();
  const row = await Model.findOne({ doctorId, storeType: 'creds', storeId: '' }).lean();
  return isUsableCreds(row ? reviveStoredValue(row.value) : null);
}

module.exports = {
  EXPIRING_TYPES,
  PERSISTENT_TYPES,
  REQUIRED_CREDS_FIELDS,
  createMongoAuthState,
  documentId,
  hasStoredWhatsAppSession,
  isBsonBinary,
  isUsableCreds,
  reviveStoredValue,
  toBuffer,
  toStorable,
  whatsappAuthSchema
};
