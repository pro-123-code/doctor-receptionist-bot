const mongoose = require('mongoose');
const crypto = require('node:crypto');
const { hashPassword } = require('./passwords');
const { encryptJson } = require('./secretBox');

const { Schema } = mongoose;

const slotSchema = new Schema({
  start: { type: Date, required: true },
  end: {
    type: Date,
    required: true,
    validate: {
      validator(value) { return value > this.start; },
      message: 'Slot end must be after its start'
    }
  }
}, { _id: false });

const conversationSchema = new Schema({
  doctorId: { type: String, required: true, index: true },
  clinicId: { type: String, required: true, index: true },
  senderJid: { type: String, required: true },
  step: { type: String, enum: ['name', 'contactNumber', 'majorSymptoms', 'appointmentDate', 'calendarSelection'], required: true },
  details: {
    name: { type: String, maxlength: 100, default: '' },
    contactNumber: { type: String, maxlength: 30, default: '' },
    majorSymptoms: { type: String, maxlength: 500, default: '' }
  },
  requestedDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
  slots: { type: [slotSchema], default: [] },
  slotPage: { type: Number, default: 0, min: 0 },
  moreSlotsAvailable: { type: Boolean, default: false },
  updatedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true, expires: 0 }
}, { versionKey: false });
conversationSchema.index({ doctorId: 1, senderJid: 1 }, { unique: true });

const appointmentSchema = new Schema({
  doctorId: { type: String, required: true, index: true },
  clinicId: { type: String, required: true, index: true },
  slotKey: { type: String, required: true },
  senderJid: { type: String, required: true },
  details: {
    name: { type: String, required: true, maxlength: 100 },
    contactNumber: { type: String, required: true, maxlength: 30 },
    majorSymptoms: { type: String, required: true, maxlength: 500 }
  },
  slotStart: { type: Date, required: true },
  bookedAt: { type: Date },
  slotEnd: {
    type: Date,
    required: true,
    validate: {
      validator(value) { return value > this.slotStart; },
      message: 'Appointment end must be after its start'
    }
  },
  status: { type: String, enum: ['pending', 'booked'], required: true },
  calendarEventId: { type: String },
  expiresAt: { type: Date, expires: 0 }
}, { timestamps: true, versionKey: false });
appointmentSchema.index({ doctorId: 1, slotKey: 1 }, { unique: true });

const serviceLogSchema = new Schema({
  doctorId: { type: String, required: true, index: true },
  clinicId: { type: String, required: true, index: true },
  level: { type: String, enum: ['error', 'warn', 'info'], required: true },
  event: { type: String, required: true, maxlength: 100 },
  code: { type: String, maxlength: 64 },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 }
}, { versionKey: false });

const dashboardLoginAttemptSchema = new Schema({
  bucketKey: { type: String, required: true, unique: true },
  attempts: { type: Number, required: true, min: 0 },
  expiresAt: { type: Date, required: true, expires: 0 }
}, { versionKey: false });

const dailyReportRunSchema = new Schema({
  doctorId: { type: String, required: true },
  clinicId: { type: String, required: true },
  dateKey: { type: String, required: true },
  status: { type: String, enum: ['running', 'sent', 'failed'], required: true },
  lockToken: { type: String, required: true },
  lockExpiresAt: { type: Date, required: true },
  sentAt: { type: Date },
  expiresAt: { type: Date, required: true, expires: 0 }
}, { timestamps: true, versionKey: false });
dailyReportRunSchema.index({ doctorId: 1, dateKey: 1 }, { unique: true });

const inboundMessageSchema = new Schema({
  doctorId: { type: String, required: true },
  senderJid: { type: String, required: true },
  messageId: { type: String, required: true },
  messageType: { type: String, enum: ['text', 'audio'], required: true },
  text: { type: String, maxlength: 10000 },
  audioData: { type: Buffer },
  audioMimeType: { type: String, maxlength: 100 },
  receivedAt: { type: Date, required: true },
  queuedAt: { type: Date, required: true, default: Date.now },
  status: { type: String, enum: ['pending', 'processing', 'replying', 'completed', 'expired', 'failed'], default: 'pending', required: true },
  responseText: { type: String, maxlength: 10000 },
  processingStartedAt: { type: Date },
  processedAt: { type: Date },
  attemptCount: { type: Number, default: 0, min: 0 },
  lastErrorCode: { type: String, maxlength: 64 },
  expiresAt: { type: Date, required: true, expires: 0 }
}, { timestamps: true, versionKey: false });
inboundMessageSchema.index({ doctorId: 1, messageId: 1 }, { unique: true });
inboundMessageSchema.index({ doctorId: 1, status: 1, queuedAt: 1, _id: 1 });

const inboundQueueLockSchema = new Schema({
  doctorId: { type: String, required: true, unique: true },
  ownerToken: { type: String, required: true },
  lockExpiresAt: { type: Date, required: true }
}, { versionKey: false });

const religiousHolidayEventSchema = new Schema({
  eventId: { type: String, required: true },
  date: { type: String, required: true },
  religion: { type: String, enum: ['Christian', 'Muslim', 'Hindu', 'Other'], required: true }
}, { _id: false });

const facilityPricingSchema = new Schema({
  category: { type: String, enum: ['facility', 'service'], default: 'facility', required: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  price: { type: Number, required: true, min: 0, max: 10_000_000 }
}, { _id: false });

const doctorSchema = new Schema({
  doctorId: { type: String, required: true, unique: true },
  doctorName: { type: String, required: true, maxlength: 120, default: 'Doctor' },
  clinicName: { type: String, required: true, maxlength: 160, default: 'Clinic' },
  email: { type: String, required: true, lowercase: true, unique: true },
  facilitiesList: { type: [String], default: [] },
  basicCheckupFee: { type: Number, min: 0, max: 10_000_000, default: null },
  facilityPricing: { type: [facilityPricingSchema], default: [] },
  servicesList: { type: [String], default: [] },
  consultationDetails: { type: String, maxlength: 2000, default: '' },
  workingDays: { type: [Number], enum: [0, 1, 2, 3, 4, 5, 6], default: [1, 2, 3, 4, 5] },
  // Per-clinic opening hours. Undefined means "use the environment default", so
  // existing clinics need no migration.
  officeStartHour: { type: Number, min: 0, max: 23 },
  officeEndHour: { type: Number, min: 1, max: 24 },
  appointmentDurationMinutes: { type: Number, min: 15, max: 240 },
  appointmentLookaheadDays: { type: Number, min: 1, max: 30 },
  // Local HH:MM at which this clinic wants its daily appointment report emailed.
  // Defaults to midnight, matching the previous fixed schedule.
  reportTime: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/, default: '00:00' },
  offDays: { type: [String], default: [] },
  religiousHolidayOpenDays: { type: [String], default: [] },
  religion: { type: String, enum: ['Christian', 'Muslim', 'Hindu', 'Other'], default: 'Other' },
  religiousHolidayEvents: { type: [religiousHolidayEventSchema], default: [] },
  setupComplete: { type: Boolean, default: false },
  welcomeMessage: { type: String, maxlength: 1000, default: '' },
  isActive: { type: Boolean, default: true },
  googleCalendarId: { type: String, default: 'primary' },
  googleCalendarConnected: { type: Boolean, default: false },
  googleCredentialsEncrypted: { type: String, select: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { versionKey: false });

const dashboardUserSchema = new Schema({
  email: { type: String, required: true, lowercase: true, unique: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['SUPERADMIN', 'DOCTOR'], required: true },
  doctorId: { type: String, default: null },
  googleOAuthNonce: { type: String, select: false },
  googleOAuthNonceExpiresAt: { type: Date, select: false },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
dashboardUserSchema.index({ doctorId: 1, role: 1 });

const Conversation = mongoose.models.Conversation || mongoose.model('Conversation', conversationSchema);
const Appointment = mongoose.models.Appointment || mongoose.model('Appointment', appointmentSchema);
const ServiceLog = mongoose.models.ServiceLog || mongoose.model('ServiceLog', serviceLogSchema);
const DashboardLoginAttempt = mongoose.models.DashboardLoginAttempt || mongoose.model('DashboardLoginAttempt', dashboardLoginAttemptSchema);
const DailyReportRun = mongoose.models.DailyReportRun || mongoose.model('DailyReportRun', dailyReportRunSchema);
const InboundMessage = mongoose.models.InboundMessage || mongoose.model('InboundMessage', inboundMessageSchema);
const InboundQueueLock = mongoose.models.InboundQueueLock || mongoose.model('InboundQueueLock', inboundQueueLockSchema);
const Doctor = mongoose.models.Doctor || mongoose.model('Doctor', doctorSchema);
const DashboardUser = mongoose.models.DashboardUser || mongoose.model('DashboardUser', dashboardUserSchema);

async function connectDatabase(uri, clinicId, doctorId = clinicId) {
  if (!uri) throw new Error('Missing MongoDB configuration: MONGODB_URI');
  if (!doctorId || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(doctorId)) {
    throw new Error('DOCTOR_ID must be a 3-64 character lowercase slug');
  }

  mongoose.connection.on('error', () => {
    console.error('MongoDB connection error');
  });

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 10
  });
  await Doctor.collection.updateMany(
    { $or: [
      { doctorName: { $exists: false } },
      { doctorName: '' },
      { facilitiesList: { $exists: false } }
    ] },
    [{ $set: {
      doctorName: {
        $cond: [
          { $ne: [{ $ifNull: ['$doctorName', ''] }, ''] },
          '$doctorName',
          { $ifNull: ['$name', ''] }
        ]
      },
      facilitiesList: {
        $cond: [
          { $gt: [{ $size: { $ifNull: ['$facilitiesList', []] } }, 0] },
          '$facilitiesList',
          { $ifNull: ['$facilities', []] }
        ]
      },
      welcomeMessage: { $ifNull: ['$welcomeMessage', ''] },
      googleCalendarConnected: { $ifNull: ['$googleCalendarConnected', false] }
    } }]
  );
  for (const [model, field] of [[Conversation, 'senderJid'], [Appointment, 'slotKey'], [DailyReportRun, 'dateKey']]) {
    const indexes = await model.collection.indexes().catch((error) => {
      if (error.code === 26 || error.codeName === 'NamespaceNotFound') return [];
      throw error;
    });
    const obsoleteIndex = indexes.find((index) =>
      index.unique && Object.keys(index.key).length === 1 && index.key[field] === 1
    );
    if (obsoleteIndex) {
      await model.collection.dropIndex(obsoleteIndex.name).catch((error) => {
        if (error.code !== 27 && error.codeName !== 'IndexNotFound') throw error;
      });
    }
  }
  await Promise.all([
    Conversation.updateMany({ clinicId: { $exists: false } }, { $set: { clinicId } }),
    Appointment.updateMany({ clinicId: { $exists: false } }, { $set: { clinicId } }),
    ServiceLog.updateMany({ clinicId: { $exists: false } }, { $set: { clinicId } }),
    DailyReportRun.updateMany({ clinicId: { $exists: false } }, { $set: { clinicId } }),
    Conversation.updateMany({ doctorId: { $exists: false } }, { $set: { doctorId } }),
    Appointment.updateMany({ doctorId: { $exists: false } }, { $set: { doctorId } }),
    ServiceLog.updateMany({ doctorId: { $exists: false } }, { $set: { doctorId } }),
    DailyReportRun.updateMany({ doctorId: { $exists: false } }, { $set: { doctorId } })
  ]);
  await Promise.all([
    Conversation.init(),
    Appointment.init(),
    ServiceLog.init(),
    DashboardLoginAttempt.init(),
    DailyReportRun.init(),
    InboundMessage.init(),
    InboundQueueLock.init(),
    Doctor.init(),
    DashboardUser.init()
  ]);
  const initialDoctorSettings = {
    doctorName: process.env.DOCTOR_NAME?.trim() || 'Doctor',
    clinicName: process.env.CLINIC_NAME?.trim() || 'Clinic',
    email: (process.env.DOCTOR_EMAIL || process.env.DASHBOARD_EMAIL || `doctor+${doctorId}@example.invalid`).toLowerCase(),
    facilitiesList: [],
    welcomeMessage: process.env.WELCOME_MESSAGE || '',
    googleCalendarId: process.env.GOOGLE_CALENDAR_ID || 'primary'
  };
  const doctorCredentialUpdate = {};
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN && process.env.DOCTOR_CONFIG_ENCRYPTION_KEY) {
    doctorCredentialUpdate.googleCredentialsEncrypted = encryptJson({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN
    });
    doctorCredentialUpdate.googleCalendarConnected = true;
  }
  await Doctor.updateOne({ doctorId }, {
    ...(Object.keys(doctorCredentialUpdate).length ? { $set: doctorCredentialUpdate } : {}),
    $setOnInsert: {
      doctorId,
      ...initialDoctorSettings,
      isActive: true
    }
  }, { upsert: true, runValidators: true });

  if (process.env.SUPERADMIN_EMAIL && process.env.SUPERADMIN_PASSWORD) {
    const email = process.env.SUPERADMIN_EMAIL.toLowerCase();
    const existingSuperadmin = await DashboardUser.findOne({ email });
    if (!existingSuperadmin) {
      await DashboardUser.create({
        email,
        passwordHash: await hashPassword(process.env.SUPERADMIN_PASSWORD),
        role: 'SUPERADMIN'
      });
    }
  }

  const legacyDoctorEmail = process.env.DASHBOARD_EMAIL?.toLowerCase();
  if (legacyDoctorEmail && process.env.DASHBOARD_PASSWORD && process.env.DASHBOARD_PASSWORD.length >= 12) {
    const existingUser = await DashboardUser.findOne({ email: legacyDoctorEmail });
    if (!existingUser) {
      await DashboardUser.create({
        email: legacyDoctorEmail,
        passwordHash: await hashPassword(process.env.DASHBOARD_PASSWORD),
        role: 'DOCTOR',
        doctorId
      });
    }
  }
  console.log('MongoDB connection ready');
}

function recordServiceLog(event, code, doctorId = process.env.DOCTOR_ID || process.env.CLINIC_ID) {
  const clinicId = doctorId;
  ServiceLog.create({ doctorId, clinicId, level: 'error', event, code })
    .catch(() => console.error('Operational log persistence failed'));
}

async function consumeDashboardLoginAttempt(ipAddress, clinicId = process.env.CLINIC_ID) {
  const secret = process.env.DASHBOARD_SESSION_SECRET || process.env.DASHBOARD_COOKIE_SECRET;
  if (!secret || secret.length < 32) throw new Error('Dashboard cookie secret is not configured');

  const now = Date.now();
  const bucketDurationMs = 15 * 60 * 1000;
  const bucketStart = Math.floor(now / bucketDurationMs) * bucketDurationMs;
  const expiresAt = new Date(bucketStart + bucketDurationMs);
  const ipHash = crypto.createHmac('sha256', secret).update(String(ipAddress || 'unknown')).digest('hex');
  const bucketKey = `${clinicId}:${ipHash}:${bucketStart}`;

  let attempt;
  try {
    attempt = await DashboardLoginAttempt.findOneAndUpdate(
      { bucketKey },
      { $inc: { attempts: 1 }, $setOnInsert: { expiresAt } },
      { upsert: true, new: true, runValidators: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    attempt = await DashboardLoginAttempt.findOneAndUpdate(
      { bucketKey },
      { $inc: { attempts: 1 } },
      { new: true, runValidators: true }
    );
  }

  return {
    allowed: attempt.attempts <= 10,
    retryAfterSeconds: Math.max(1, Math.ceil((expiresAt.getTime() - now) / 1000))
  };
}

async function claimDailyReportRun(clinicId, dateKey, lockToken, doctorId = process.env.DOCTOR_ID || clinicId) {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 5 * 60 * 1000);
  const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const update = {
    $set: { status: 'running', lockToken, lockExpiresAt: leaseUntil, expiresAt }
  };
  const existing = await DailyReportRun.findOneAndUpdate({
    doctorId,
    dateKey,
    $or: [{ status: 'failed' }, { status: 'running', lockExpiresAt: { $lte: now } }]
  }, update, { new: true, runValidators: true });
  if (existing) return true;

  try {
    await DailyReportRun.create({
      doctorId,
      clinicId,
      dateKey,
      status: 'running',
      lockToken,
      lockExpiresAt: leaseUntil,
      expiresAt
    });
    return true;
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }
}

async function completeDailyReportRun(clinicId, dateKey, lockToken, sent, doctorId = process.env.DOCTOR_ID || clinicId) {
  const update = {
    $set: {
      status: sent ? 'sent' : 'failed',
      lockExpiresAt: new Date()
    }
  };
  if (sent) update.$set.sentAt = new Date();
  return DailyReportRun.updateOne({ doctorId, dateKey, lockToken, status: 'running' }, update);
}

async function getConversation(senderJid, doctorId = process.env.DOCTOR_ID || process.env.CLINIC_ID) {
  const clinicId = doctorId;
  return Conversation.findOne({ doctorId, senderJid }).lean();
}

async function saveConversation(senderJid, conversation, doctorId = process.env.DOCTOR_ID || process.env.CLINIC_ID) {
  const clinicId = doctorId;
  const now = new Date();
  return Conversation.findOneAndUpdate(
    { doctorId, senderJid },
    {
      $set: {
        doctorId,
        clinicId,
        step: conversation.step,
        details: conversation.details,
        requestedDate: conversation.requestedDate,
        slots: conversation.slots || [],
        slotPage: Number.isInteger(conversation.slotPage) && conversation.slotPage > 0 ? conversation.slotPage : 0,
        moreSlotsAvailable: conversation.moreSlotsAvailable === true,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + 30 * 60 * 1000)
      }
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );
}

async function deleteConversation(senderJid, doctorId = process.env.DOCTOR_ID || process.env.CLINIC_ID) {
  const clinicId = doctorId;
  await Conversation.deleteOne({ doctorId, senderJid });
}

module.exports = {
  Appointment,
  DailyReportRun,
  InboundMessage,
  InboundQueueLock,
  claimDailyReportRun,
  completeDailyReportRun,
  DashboardUser,
  Doctor,
  ServiceLog,
  connectDatabase,
  consumeDashboardLoginAttempt,
  deleteConversation,
  getConversation,
  recordServiceLog,
  saveConversation
};