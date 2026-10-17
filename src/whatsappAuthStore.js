// WhatsApp authentication state stored in MongoDB instead of the local filesystem.
//
// useMultiFileAuthState writes the credentials to files, so on a platform whose
// filesystem is wiped on every deploy each clinic has to rescan its QR code. The
// credentials and the Signal keys therefore live in MongoDB, which is already
// persistent and already the system of record for every other clinic setting.
//
// The store satisfies Baileys' SignalKeyStore contract: get(type, ids) returns a
// map keyed by id, set(data) writes a set per type, and a null value means delete.
// Uint8Array values are converted to Buffer because that is what the MongoDB
// driver stores natively.
const mongoose = require('mongoose');

// Baileys value per store type. 'pre-key' and 'sender-key' must survive a restart
// or the counterpart's message cannot be decrypted, so they have no expiry.
const PERSISTENT_TYPES = new Set(['pre-key', 'sender-key']);
const EXPIRING_TYPES = new Set(['session', 'sender-key-memory', 'app-state-sync-key', 'app-state-sync-version']);

function toBuffer(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
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

// Builds the Baileys auth state backed by MongoDB for one clinic.
// The model can be supplied so the store can be exercised without a live database.
function createMongoAuthState(doctorId, options = {}) {
  const Model = options.Model || whatsappAuthSchema();
  const scoped = { doctorId };

  const credsModel = {
    async get() {
      const doc = await Model.findOne({ ...scoped, storeType: 'creds', storeId: '' }).lean();
      return doc?.value || null;
    },
    async set(value) {
      await Model.updateOne(
        { ...scoped, storeType: 'creds', storeId: '' },
        { $set: { value, expiresAt: null } },
        { upsert: true }
      );
    },
    async clear() {
      await Model.deleteMany({ ...scoped });
    }
  };

  const keys = {
    async get(type, ids) {
      if (!Array.isArray(ids) || ids.length === 0) return {};
      const rows = await Model.find({ ...scoped, storeType: type, storeId: { $in: ids } }).lean();
      const data = {};
      for (const row of rows) {
        if (row.value !== null && row.value !== undefined) data[row.storeId] = row.value;
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
                  value: toBuffer(value),
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
    // Baileys only reads creds and keys out of the auth object, and writes creds
    // through creds.update, which the socket triggers on every rotation.
    state: { creds: credsModel, keys, getVersion: () => 3 },
    saveCreds: async (creds) => {
      if (!creds) return;
      await credsModel.set(creds);
    },
    wipe: async () => {
      await Model.deleteMany({ ...scoped });
    },
    Model
  };
}

module.exports = {
  EXPIRING_TYPES,
  PERSISTENT_TYPES,
  createMongoAuthState,
  documentId,
  toBuffer,
  whatsappAuthSchema
};