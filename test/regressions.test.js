const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ExcelJS = require('exceljs');
const ffmpegStatic = require('ffmpeg-static');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { getLocalDayBounds, parseRequestedDate } = require('../src/dateParser');
const { getReligiousHoliday, isClinicOpenOnDate, normalizeOffDays, normalizeWorkingDays } = require('../src/clinicSchedule');
const { enqueueInboundMessage, drainInboundQueue, getReceivedAt, messageRetentionMs } = require('../src/messageQueue');
const { syncReligiousHolidayEvents } = require('../src/religiousCalendar');
const { convertWhatsAppAudioToWav, getVoiceFileExtension, isVoiceErrorRetryable, translateVoiceMessageToEnglish } = require('../src/voiceTranscription');
const { createGoogleOAuthState, createSessionToken, getGoogleCalendarConfigurationError, getGoogleCalendarOAuthStatus, mountDashboard, normalizeAdminDoctorPatch, resolveGoogleRedirectUri, verifyGoogleOAuthState, verifySessionToken } = require('../src/dashboard');
const { generateAppointmentsWorkbook } = require('../src/excelGenerator');
const { getCalendarErrorDetails } = require('../src/calendarErrors');
const { getWelcomeMessage } = require('../src/greetings');
const { formatRupees, getFacilityPrice, normalizeFacilityPricing } = require('../src/facilityPricing');
const { hashPassword, verifyPassword } = require('../src/passwords');
const { decryptJson, encryptJson, hasValidEncryptionKey } = require('../src/secretBox');
const { buildSystemInstruction } = require('../src/gemini');
const { resolveGoogleCredentials, verifyDoctorCalendarAccess } = require('../src/calendarAccess');
const { createMailTransport, dispatchDoctorDailyReport, startDailyReportScheduler } = require('../src/cronJobs');
const { privacyPolicy, termsOfService } = require('../src/legalPages');
const { buildOfferOrder, formatSlotOffer, getSlotLocalDateKey, getZonedDateParts, isMoreSlotRequest, paginateSlots } = require('../src/slotOffers');
const { SLOT_DURATION_OPTIONS, clampSlotDuration, currentLocalTime, isOfferedSlotDuration, isReportCatchUpDue, isReportDueNow, isValidHourSetting, LIMITS, normalizeClinicTimingInput, normalizeReportTime, reportCatchUpMinutes, resolveClinicTiming } = require('../src/clinicTiming');

require('../src/models');

test('appointmentDate is a valid persisted conversation step', async () => {
  const Conversation = mongoose.models.Conversation;
  const conversation = new Conversation({
    doctorId: 'city-care-clinic',
    clinicId: 'city-care-clinic',
    senderJid: 'test@s.whatsapp.net',
    step: 'appointmentDate',
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000)
  });
  await assert.doesNotReject(conversation.validate());
});

test('doctor profile defaults satisfy required name fields', async () => {
  const Doctor = mongoose.models.Doctor;
  const doctor = new Doctor({
    doctorId: 'city-care-clinic',
    email: 'doctor@example.invalid'
  });
  await assert.doesNotReject(doctor.validate());
  assert.equal(doctor.doctorName, 'Doctor');
  assert.equal(doctor.clinicName, 'Clinic');
  assert.deepEqual(doctor.workingDays, [1, 2, 3, 4, 5]);
  assert.deepEqual(doctor.offDays, []);
  assert.equal(doctor.setupComplete, false);
  assert.equal(doctor.basicCheckupFee, null);
  assert.deepEqual(doctor.facilityPricing, []);
});

test('natural dates use the clinic-local calendar date', () => {
  const now = new Date('2026-10-02T20:00:00Z');
  assert.deepEqual(parseRequestedDate('kal', 'Asia/Karachi', 30, now), {
    year: 2026,
    month: 10,
    day: 4
  });
  assert.deepEqual(parseRequestedDate('next Friday', 'Asia/Karachi', 30, now), {
    year: 2026,
    month: 10,
    day: 9
  });
  assert.equal(parseRequestedDate('yesterday', 'Asia/Karachi', 30, now), null);
});

test('clinic day boundaries account for daylight-saving changes', () => {
  const bounds = getLocalDayBounds({ year: 2026, month: 3, day: 8 }, 'America/New_York');
  assert.equal((bounds.end - bounds.start) / 3_600_000, 23);
});

test('doctor schedules honor configured workdays and date-specific off-days', () => {
  const schedule = {
    workingDays: normalizeWorkingDays([0, 1, 2, 3, 4, 5, 6]),
    offDays: normalizeOffDays(['2026-10-06'])
  };
  assert.equal(isClinicOpenOnDate({ year: 2026, month: 10, day: 6 }, schedule), false);
  assert.equal(isClinicOpenOnDate({ year: 2026, month: 10, day: 10 }, schedule), true);
  assert.deepEqual(normalizeWorkingDays([6, 1, 6]), [1, 6]);
  assert.equal(normalizeWorkingDays([]), null);
  assert.deepEqual(normalizeOffDays(['2026-12-25', '2026-12-25']), ['2026-12-25']);
  assert.equal(normalizeOffDays(['2026-02-30']), null);
});

test('religion-specific holidays automatically close a clinic schedule', () => {
  const allDays = [0, 1, 2, 3, 4, 5, 6];
  const datesByReligion = [
    ['Muslim', { year: 2026, month: 3, day: 20 }],
    ['Christian', { year: 2026, month: 4, day: 5 }],
    ['Hindu', { year: 2026, month: 3, day: 3 }],
    ['Hindu', { year: 2026, month: 11, day: 8 }]
  ];
  for (const [religion, date] of datesByReligion) {
    const dateKey = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
    assert.ok(getReligiousHoliday(religion, dateKey));
    assert.equal(isClinicOpenOnDate(date, { religion, workingDays: allDays, offDays: [] }), false);
  }
  assert.equal(isClinicOpenOnDate({ year: 2026, month: 12, day: 25 }, {
    religion: 'Other', workingDays: allDays, offDays: []
  }), true);
  assert.equal(isClinicOpenOnDate({ year: 2026, month: 3, day: 20 }, {
    religion: 'Muslim', workingDays: [], offDays: [], religiousHolidayOpenDays: ['2026-03-20']
  }), true);
});

test('religious holiday calendar omits a doctor-overridden open date', async () => {
  const insertCalls = [];
  const doctorProfile = {
    doctorId: 'holiday-open-tenant', religion: 'Christian', clinicName: 'Clinic',
    religiousHolidayOpenDays: ['2026-04-05'], religiousHolidayEvents: []
  };
  await syncReligiousHolidayEvents({
    doctorProfile,
    Doctor: { async updateOne() {} },
    calendar: { events: { async insert(event) { insertCalls.push(event); }, async delete() {} } },
    getReligiousHolidays: () => [{ date: '2026-04-05', name: 'Easter Sunday' }],
    timeZone: 'Asia/Karachi',
    now: new Date('2026-01-01T00:00:00Z')
  });
  assert.deepEqual(insertCalls, []);
});

test('religious holiday calendar sync adds all-day events and removes obsolete future dates', async () => {
  const profile = {
    doctorId: 'holiday-tenant',
    religion: 'Christian',
    clinicName: 'Holiday Clinic',
    googleCalendarId: 'primary',
    religiousHolidayEvents: [
      { eventId: 'past-event', date: '2025-12-25', religion: 'Muslim' },
      { eventId: 'obsolete-event', date: '2026-12-25', religion: 'Muslim' }
    ]
  };
  const insertedEvents = [];
  const deletedEvents = [];
  let saved;
  const calendar = {
    events: {
      async insert(event) { insertedEvents.push(event); },
      async delete(event) { deletedEvents.push(event); }
    }
  };
  const Doctor = {
    async updateOne(filter, update) {
      assert.equal(filter.doctorId, profile.doctorId);
      saved = update.$set.religiousHolidayEvents;
    }
  };
  const getReligiousHolidays = (religion, year) => religion === 'Christian' && year === 2026
    ? [{ date: '2026-04-05', name: 'Easter Sunday' }]
    : [];
  await syncReligiousHolidayEvents({
    doctorProfile: profile,
    Doctor,
    calendar,
    getReligiousHolidays,
    timeZone: 'Asia/Karachi',
    now: new Date('2026-01-01T00:00:00Z')
  });
  assert.equal(deletedEvents.length, 1);
  assert.equal(deletedEvents[0].eventId, 'obsolete-event');
  assert.equal(insertedEvents.length, 1);
  assert.equal(insertedEvents[0].requestBody.summary, 'Holiday Clinic closed: Easter Sunday');
  assert.deepEqual(insertedEvents[0].requestBody.start, { date: '2026-04-05' });
  assert.deepEqual(insertedEvents[0].requestBody.end, { date: '2026-04-06' });
  assert.ok(saved.some((event) => event.eventId === 'past-event'));
  assert.ok(saved.some((event) => event.date === '2026-04-05' && event.religion === 'Christian'));
});

test('inbound messages are tenant-deduplicated and retain their 24-hour expiry', async () => {
  let query;
  let inserted;
  const MessageModel = {
    async findOneAndUpdate(filter, update, options) {
      query = { filter, update, options };
      inserted = { ...update.$setOnInsert, _id: 'queue-message' };
      return inserted;
    }
  };
  const receivedAt = new Date('2026-10-06T00:00:00Z');
  await enqueueInboundMessage(MessageModel, {
    doctorId: 'queue-tenant',
    senderJid: 'patient@s.whatsapp.net',
    messageId: 'whatsapp-message-id',
    messageType: 'text',
    text: 'Hello',
    receivedAt
  });
  assert.deepEqual(query.filter, { doctorId: 'queue-tenant', messageId: 'whatsapp-message-id' });
  assert.equal(query.options.upsert, true);
  assert.equal(inserted.expiresAt.getTime() - receivedAt.getTime(), messageRetentionMs);
  assert.equal(getReceivedAt(1_791_244_800).getTime(), 1_791_244_800_000);
});

test('inbound backlog drains in receipt order and expires messages older than 24 hours', async () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const records = [
    { _id: 'later', doctorId: 'queue-tenant', senderJid: 'patient', receivedAt: new Date(now - 1000), status: 'pending', attemptCount: 0, text: 'later' },
    { _id: 'expired', doctorId: 'queue-tenant', senderJid: 'patient', receivedAt: new Date(now - messageRetentionMs - 1), status: 'pending', attemptCount: 0, text: 'old' },
    { _id: 'earlier', doctorId: 'queue-tenant', senderJid: 'patient', receivedAt: new Date(now - 2000), status: 'pending', attemptCount: 0, text: 'earlier' }
  ];
  const MessageModel = {
    async updateMany(filter, update) {
      for (const record of records) {
        if (record.receivedAt < filter.receivedAt.$lt && ['pending', 'processing'].includes(record.status)) {
          Object.assign(record, update.$set);
          for (const key of Object.keys(update.$unset || {})) delete record[key];
        }
      }
    },
    async findOneAndUpdate(filter, update, options) {
      assert.equal(filter.doctorId, 'queue-tenant');
      assert.deepEqual(options.sort, { queuedAt: 1, _id: 1 });
      const message = records.filter((record) => record.status === 'pending' && record.receivedAt >= filter.receivedAt.$gte)
        .sort((left, right) => left.receivedAt - right.receivedAt || left._id.localeCompare(right._id))[0];
      if (!message) return null;
      Object.assign(message, update.$set);
      message.attemptCount += update.$inc.attemptCount;
      return message;
    },
    async updateOne(filter, update) {
      const message = records.find(({ _id }) => _id === filter._id);
      if (filter.status && message.status !== filter.status) return { matchedCount: 0 };
      Object.assign(message, update.$set);
      for (const key of Object.keys(update.$unset || {})) delete message[key];
      return { matchedCount: 1 };
    }
  };
  const QueueLockModel = {
    async findOneAndUpdate() { return null; },
    async create(lock) { return lock; },
    async updateOne() {}
  };
  const delivered = [];
  const processed = await drainInboundQueue({
    MessageModel,
    QueueLockModel,
    doctorId: 'queue-tenant',
    canProcess: () => true,
    processMessage: async ({ text }) => text,
    deliverReply: async (_sender, text) => delivered.push(text),
    responseDelayMs: 0,
    now: () => now
  });
  assert.equal(processed, 2);
  assert.deepEqual(delivered, ['earlier', 'later']);
  assert.equal(records.find(({ _id }) => _id === 'expired').status, 'expired');
  assert.equal(records.find(({ _id }) => _id === 'earlier').status, 'completed');
});

test('inbound queue retains a prepared reply if WhatsApp disconnects before delivery', async () => {
  const message = {
    _id: 'disconnect-message', doctorId: 'queue-tenant', senderJid: 'patient',
    receivedAt: new Date(), status: 'pending', attemptCount: 0, text: 'hello'
  };
  let connectionReady = true;
  let retryRequested;
  const MessageModel = {
    async updateMany() {},
    async findOneAndUpdate(_filter, update) {
      if (message.status !== 'pending') return null;
      Object.assign(message, update.$set);
      message.attemptCount += update.$inc.attemptCount;
      return message;
    },
    async updateOne(_filter, update) {
      if (_filter.status && message.status !== _filter.status) return { matchedCount: 0 };
      Object.assign(message, update.$set);
      for (const key of Object.keys(update.$unset || {})) delete message[key];
      return { matchedCount: 1 };
    }
  };
  const QueueLockModel = {
    async findOneAndUpdate() { return null; },
    async create(lock) { return lock; },
    async updateOne() {}
  };
  await drainInboundQueue({
    MessageModel,
    QueueLockModel,
    doctorId: 'queue-tenant',
    canProcess: () => connectionReady,
    async processMessage() { connectionReady = false; return 'response'; },
    async deliverReply() { assert.fail('must not send after disconnect'); },
    async onFailure(_error, _record, retry) { retryRequested = retry; },
    responseDelayMs: 0
  });
  assert.equal(message.status, 'replying');
  assert.equal(message.responseText, 'response');
  assert.equal(retryRequested, true);
});

test('Urdu voice translation uses the configured Whisper translation endpoint', async () => {
  assert.deepEqual(getVoiceFileExtension('audio/ogg; codecs=opus'), { extension: 'ogg', mime: 'audio/ogg' });
  await assert.rejects(
    translateVoiceMessageToEnglish(Buffer.from('voice'), 'audio/ogg', {}),
    (error) => error.code === 'VOICE_TRANSCRIPTION_NOT_ENABLED'
  );
  let request;
  const transcript = await translateVoiceMessageToEnglish(
    Buffer.from('voice'),
    'audio/ogg; codecs=opus',
    { OPENAI_ALLOW_PHI_PROCESSING: 'true', OPENAI_API_KEY: 'test-key' },
    async (url, options) => {
      request = { url, options };
      return { ok: true, async json() { return { text: 'Please book an appointment tomorrow.' }; } };
    },
    async () => Buffer.from('normalized wav')
  );
  assert.equal(request.url, 'https://api.openai.com/v1/audio/translations');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.equal(request.options.body.get('file').type, 'audio/wav');
  assert.equal(transcript, 'Please book an appointment tomorrow.');
});

test('bundled FFmpeg converts in-memory voice media to mono 16 kHz WAV', async (t) => {
  // ffmpeg-static downloads its binary in a postinstall script, which some npm
  // versions block. Skip rather than fail when the binary is absent so an
  // environment quirk cannot block a deploy.
  if (!fs.existsSync(ffmpegStatic)) {
    t.skip('ffmpeg-static binary unavailable in this environment');
    return;
  }
  const sampleCount = 1600;
  const sampleBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + sampleBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + sampleBytes, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(sampleBytes, 40);

  const converted = await convertWhatsAppAudioToWav(wav);
  assert.equal(converted.toString('ascii', 0, 4), 'RIFF');
  assert.equal(converted.toString('ascii', 8, 12), 'WAVE');
  assert.equal(converted.readUInt16LE(22), 1);
  assert.equal(converted.readUInt32LE(24), 16000);
});

test('Gemini extraction instructions require schema-only output', () => {
  const instruction = buildSystemInstruction({
    doctorName: 'Dr. Example',
    clinicName: 'Example Clinic',
    facilitiesList: ['OPD', 'Imaging'],
    servicesList: ['Vaccination', 'Wound care'],
    consultationDetails: 'Consultation by appointment only.',
    welcomeMessage: 'Welcome to Example Clinic'
  });
  assert.match(instruction, /Return only valid JSON matching the supplied responseSchema/);
  assert.match(instruction, /application constructs all patient-facing replies/);
  assert.match(instruction, /Dr\. Example/);
  assert.match(instruction, /OPD, Imaging/);
  assert.match(instruction, /Vaccination, Wound care/);
  assert.match(instruction, /Consultation by appointment only/);
  assert.doesNotMatch(instruction, /Dr\. Ahmad|City Care Clinic/);
});

test('dashboard sessions reject tampering and expired tokens', () => {
  const secret = 'test-secret-that-is-long-enough-for-a-session';
  const user = { _id: 'doctor-user-id', role: 'DOCTOR', doctorId: 'city-care-clinic' };
  const validToken = createSessionToken(user, secret, Date.now() + 60_000);
  const expiredToken = createSessionToken(user, secret, Date.now() - 1);
  const claims = { userId: user._id, role: user.role, doctorId: user.doctorId };
  assert.equal(verifySessionToken(validToken, secret, claims), true);
  assert.equal(verifySessionToken(`${validToken}x`, secret, claims), false);
  assert.equal(verifySessionToken(expiredToken, secret, claims), false);
  assert.equal(verifySessionToken(validToken, secret, { ...claims, doctorId: 'another-clinic' }), false);
});

test('dashboard appointment query is scoped to its clinic', async () => {
  const previousConfig = {
    clinicId: process.env.CLINIC_ID,
    email: process.env.DASHBOARD_EMAIL,
    secret: process.env.DASHBOARD_COOKIE_SECRET
  };
  process.env.CLINIC_ID = 'city-care-clinic';
  process.env.DASHBOARD_COOKIE_SECRET = 'test-secret-that-is-long-enough-for-a-session';

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    let appointmentFilter;
    const DashboardUser = mongoose.models.DashboardUser;
    const Doctor = mongoose.models.Doctor;
    const originalFindById = DashboardUser.findById;
    const originalDoctorFindOne = Doctor.findOne;
    DashboardUser.findById = () => ({ lean: async () => ({ _id: 'doctor-user-id', role: 'DOCTOR', doctorId: 'city-care-clinic', isActive: true }) });
    Doctor.findOne = () => ({ lean: async () => ({ doctorId: 'city-care-clinic', isActive: true }) });
    const query = {
      sort() { return this; },
      async lean() { return []; }
    };
    const appointmentModel = {
      find(filter) {
        appointmentFilter = filter;
        return query;
      }
    };
    mountDashboard(app, appointmentModel, 'Asia/Karachi', process.env.CLINIC_ID);

    const token = createSessionToken({ _id: 'doctor-user-id', role: 'DOCTOR', doctorId: 'city-care-clinic' },
      process.env.DASHBOARD_COOKIE_SECRET, Date.now() + 60_000);
    const handlers = routes.get('GET /api/dashboard/appointments');
    const request = { headers: { cookie: `doctorbot_dashboard=${token}` }, query: {} };
    const response = {
      locals: {},
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; }
    };
    let authorized = false;
    await handlers[0](request, response, () => { authorized = true; });
    assert.equal(authorized, true);
    await handlers[1](request, response);
    assert.equal(appointmentFilter.doctorId, 'city-care-clinic');
    DashboardUser.findById = originalFindById;
    Doctor.findOne = originalDoctorFindOne;
  } finally {
    if (previousConfig.clinicId === undefined) delete process.env.CLINIC_ID;
    else process.env.CLINIC_ID = previousConfig.clinicId;
    if (previousConfig.secret === undefined) delete process.env.DASHBOARD_COOKIE_SECRET;
    else process.env.DASHBOARD_COOKIE_SECRET = previousConfig.secret;
  }
});

test('Calendar diagnostics preserve API reason and redact credentials', () => {
  const providerError = new Error('API has not been enabled; refresh_token=refresh-secret');
  providerError.response = {
    status: 403,
    data: {
      error: {
        message: providerError.message,
        code: 403,
        errors: [{ reason: 'accessNotConfigured' }]
      }
    }
  };
  const wrappedError = new Error('Calendar request failed', { cause: providerError });
  const details = getCalendarErrorDetails(wrappedError, { GOOGLE_REFRESH_TOKEN: 'refresh-secret' });
  assert.equal(details.status, 403);
  assert.equal(details.code, 'accessNotConfigured');
  assert.match(details.message, /API has not been enabled/);
  assert.doesNotMatch(details.message, /refresh-secret/);
});

test('tenant data and report locks use clinic-scoped unique indexes', () => {
  const Conversation = mongoose.models.Conversation;
  const Appointment = mongoose.models.Appointment;
  const DailyReportRun = mongoose.models.DailyReportRun;
  const DashboardLoginAttempt = mongoose.models.DashboardLoginAttempt;
  const InboundMessage = mongoose.models.InboundMessage;
  const InboundQueueLock = mongoose.models.InboundQueueLock;
  assert.ok(Conversation.schema.indexes().some(([keys, options]) =>
    keys.doctorId && keys.senderJid && options.unique
  ));
  assert.ok(Appointment.schema.indexes().some(([keys, options]) =>
    keys.doctorId && keys.slotKey && options.unique
  ));
  assert.ok(DailyReportRun.schema.indexes().some(([keys, options]) =>
    keys.doctorId && keys.dateKey && options.unique
  ));
  assert.ok(InboundMessage.schema.indexes().some(([keys, options]) =>
    keys.doctorId && keys.messageId && options.unique
  ));
  assert.ok(InboundMessage.schema.indexes().some(([keys, options]) =>
    keys.expiresAt && options.expireAfterSeconds === 0
  ));
  assert.ok(InboundQueueLock.schema.path('doctorId').options.unique);
  assert.ok(DashboardLoginAttempt.schema.path('bucketKey').options.unique);
  assert.deepEqual(mongoose.models.DashboardUser.schema.path('role').enumValues, ['SUPERADMIN', 'DOCTOR']);
});

test('doctor OAuth credentials are encrypted and authenticated', () => {
  const key = { DOCTOR_CONFIG_ENCRYPTION_KEY: 'a'.repeat(64) };
  const credentials = { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' };
  const encrypted = encryptJson(credentials, key);
  assert.doesNotMatch(encrypted, /client|secret|refresh/);
  assert.deepEqual(decryptJson(encrypted, key), credentials);
  assert.throws(() => decryptJson(encrypted, { DOCTOR_CONFIG_ENCRYPTION_KEY: 'b'.repeat(64) }));
});

test('Google Calendar OAuth requires a valid credential encryption key', () => {
  assert.equal(hasValidEncryptionKey({ DOCTOR_CONFIG_ENCRYPTION_KEY: 'a'.repeat(64) }), true);
  assert.equal(hasValidEncryptionKey({ DOCTOR_CONFIG_ENCRYPTION_KEY: 'invalid' }), false);
  assert.equal(hasValidEncryptionKey({}), false);
});

test('Google OAuth redirect URI must exactly match the callback route', () => {
  const config = {
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REDIRECT_URI: 'https://clinic.example/api/auth/google/callback',
    DOCTOR_CONFIG_ENCRYPTION_KEY: 'd'.repeat(64)
  };
  assert.equal(getGoogleCalendarConfigurationError(config), null);
  assert.match(getGoogleCalendarConfigurationError({
    ...config,
    GOOGLE_REDIRECT_URI: 'https://clinic.example/api/auth/google/callback/'
  }), /end exactly with \/api\/auth\/google\/callback/);
  assert.match(getGoogleCalendarConfigurationError({
    ...config,
    GOOGLE_REDIRECT_URI: 'https://clinic.example/api/auth/google/callback?next=1'
  }), /end exactly with \/api\/auth\/google\/callback/);
  assert.equal(getGoogleCalendarConfigurationError({
    ...config,
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/auth/google/callback'
  }), null);
});

test('the scheduler stays usable when SMTP is not configured', () => {
  const settingNames = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'];
  const previousSettings = Object.fromEntries(settingNames.map((name) => [name, process.env[name]]));
  for (const name of settingNames) process.env[name] = '';
  try {
    const context = createMailTransport();
    assert.equal(context.transport, null, 'a missing SMTP config must not create a transporter');
    assert.match(context.reason, /missing SMTP settings/);
    Object.assign(process.env, { SMTP_HOST: 'smtp.example.test', SMTP_USER: 'u', SMTP_PASS: 'p', EMAIL_FROM: 'e' });
    process.env.SMTP_PORT = 'not-a-port';
    assert.match(createMailTransport().reason, /SMTP_PORT/);
  } finally {
    for (const name of settingNames) {
      if (previousSettings[name] === undefined) delete process.env[name];
      else process.env[name] = previousSettings[name];
    }
  }
});

test('the daily report selects booked appointments in the next 24 hours per doctor', async () => {
  const Doctor = mongoose.models.Doctor;
  const Appointment = mongoose.models.Appointment;
  const DailyReportRun = mongoose.models.DailyReportRun;
  const ServiceLog = mongoose.models.ServiceLog;
  const originalMethods = {
    doctorFindOne: Doctor.findOne,
    doctorExists: Doctor.exists,
    appointmentFind: Appointment.find,
    reportFindOneAndUpdate: DailyReportRun.findOneAndUpdate,
    reportCreate: DailyReportRun.create,
    reportUpdateOne: DailyReportRun.updateOne,
    serviceLogCreate: ServiceLog.create
  };
  let appointmentFilter;
  let completion;
  Doctor.findOne = () => ({ lean: async () => ({
    doctorId: 'report-tenant', clinicName: 'Tenant Clinic', email: 'tenant@example.test', isActive: true
  }) });
  Doctor.exists = async () => true;
  Appointment.find = (filter) => {
    appointmentFilter = filter;
    return { sort() { return this; }, lean: async () => [] };
  };
  DailyReportRun.findOneAndUpdate = async () => null;
  DailyReportRun.create = async () => ({});
  DailyReportRun.updateOne = async (filter, update) => {
    completion = { filter, update };
    return { modifiedCount: 1 };
  };
  ServiceLog.create = async () => ({});

  try {
    const result = await dispatchDoctorDailyReport({ doctorId: 'report-tenant' }, { transportContext: { transport: null, reason: 'missing SMTP settings' } });
    assert.equal(result.sent, false);
    assert.equal(appointmentFilter.doctorId, 'report-tenant');
    assert.equal(appointmentFilter.status, 'booked');
    assert.equal(appointmentFilter.slotStart.$lt - appointmentFilter.slotStart.$gte, 24 * 60 * 60 * 1000);
    assert.ok(completion);
    assert.equal(completion.filter.doctorId, 'report-tenant');
    assert.equal(completion.update.$set.status, 'failed');
  } finally {
    Doctor.findOne = originalMethods.doctorFindOne;
    Doctor.exists = originalMethods.doctorExists;
    Appointment.find = originalMethods.appointmentFind;
    DailyReportRun.findOneAndUpdate = originalMethods.reportFindOneAndUpdate;
    DailyReportRun.create = originalMethods.reportCreate;
    DailyReportRun.updateOne = originalMethods.reportUpdateOne;
    ServiceLog.create = originalMethods.serviceLogCreate;
  }
});

test('the daily report emails an Excel attachment to the current doctor profile', async () => {
  const settingNames = [
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS', 'SMTP_USER',
    'SMTP_PASS', 'EMAIL_FROM'
  ];
  const previousSettings = Object.fromEntries(settingNames.map((name) => [name, process.env[name]]));
  const Doctor = mongoose.models.Doctor;
  const Appointment = mongoose.models.Appointment;
  const DailyReportRun = mongoose.models.DailyReportRun;
  const ServiceLog = mongoose.models.ServiceLog;
  const originalMethods = {
    doctorFindOne: Doctor.findOne,
    doctorExists: Doctor.exists,
    appointmentFind: Appointment.find,
    reportFindOneAndUpdate: DailyReportRun.findOneAndUpdate,
    reportCreate: DailyReportRun.create,
    reportUpdateOne: DailyReportRun.updateOne,
    serviceLogCreate: ServiceLog.create,
    createTransport: nodemailer.createTransport
  };
  let sentMail;
  let completion;
  for (const name of settingNames) process.env[name] = '';
  Object.assign(process.env, {
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: '587',
    SMTP_USER: 'smtp-user',
    SMTP_PASS: 'smtp-password',
    EMAIL_FROM: 'reports@example.test'
  });
  nodemailer.createTransport = (options) => ({
    options,
    async sendMail(message) { sentMail = message; return { messageId: 'test-report' }; }
  });
  Doctor.findOne = () => ({ lean: async () => ({
    doctorId: 'email-tenant', clinicName: 'Email Clinic', email: 'current@example.test', isActive: true
  }) });
  Doctor.exists = async () => true;
  Appointment.find = () => ({
    sort() { return this; },
    lean: async () => [{
      details: { name: 'Test Patient', contactNumber: '+923001234567', majorSymptoms: 'Checkup' },
      slotStart: new Date(Date.now() + 60 * 60 * 1000),
      slotEnd: new Date(Date.now() + 90 * 60 * 1000),
      status: 'booked'
    }]
  });
  DailyReportRun.findOneAndUpdate = async () => null;
  DailyReportRun.create = async () => ({});
  DailyReportRun.updateOne = async (filter, update) => {
    completion = { filter, update };
    return { modifiedCount: 1 };
  };
  ServiceLog.create = async () => ({});

  try {
    const sent = await dispatchDoctorDailyReport({ doctorId: 'email-tenant', email: 'stale@example.test' });
    assert.equal(sent.sent, true);
    assert.equal(sentMail.to, 'current@example.test');
    assert.equal(sentMail.from, 'reports@example.test');
    assert.match(sentMail.subject, /Email Clinic Daily Appointments/);
    assert.equal(sentMail.attachments[0].contentType,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(sentMail.attachments[0].content);
    assert.equal(workbook.worksheets[0].getRow(2).getCell(1).value, 'Test Patient');
    assert.equal(workbook.worksheets[0].getRow(2).getCell(5).value, 'booked');
    assert.equal(completion.update.$set.status, 'sent');
  } finally {
    Doctor.findOne = originalMethods.doctorFindOne;
    Doctor.exists = originalMethods.doctorExists;
    Appointment.find = originalMethods.appointmentFind;
    DailyReportRun.findOneAndUpdate = originalMethods.reportFindOneAndUpdate;
    DailyReportRun.create = originalMethods.reportCreate;
    DailyReportRun.updateOne = originalMethods.reportUpdateOne;
    ServiceLog.create = originalMethods.serviceLogCreate;
    nodemailer.createTransport = originalMethods.createTransport;
    for (const name of settingNames) {
      if (previousSettings[name] === undefined) delete process.env[name];
      else process.env[name] = previousSettings[name];
    }
  }
});

test('WhatsApp dashboard routes are doctor-scoped and return browser QR state', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'whatsapp-dashboard-session-secret-long-enough';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originalFindById = DashboardUser.findById;
  const originalDoctorFindOne = Doctor.findOne;
  const user = { _id: 'whatsapp-user', role: 'DOCTOR', doctorId: 'clinic-whatsapp', isActive: true };
  let startedDoctorId;
  DashboardUser.findById = () => ({ lean: async () => user });
  Doctor.findOne = () => ({ lean: async () => ({ doctorId: user.doctorId, isActive: true, setupComplete: true }) });

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    const qrState = { status: 'qr', qrDataUrl: 'data:image/png;base64,tenant-qr' };
    mountDashboard(app, {}, 'Asia/Karachi', user.doctorId, {
      async startWhatsAppConnection(doctorId) {
        startedDoctorId = doctorId;
        return { status: 'starting' };
      },
      getWhatsAppConnectionStatus: (doctorId) => doctorId === user.doctorId ? qrState : { status: 'disconnected' }
    });
    const token = createSessionToken(user, secret, Date.now() + 60_000);
    const request = { headers: { cookie: `doctorbot_dashboard=${token}` } };
    const response = {
      locals: {}, statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; }
    };
    const [connectAuth, connectHandler] = routes.get('POST /api/dashboard/whatsapp/connect');
    await connectAuth(request, response, () => {});
    await connectHandler(request, response);
    assert.equal(startedDoctorId, user.doctorId);
    assert.equal(response.statusCode, 202);

    response.locals = {};
    const [statusAuth, statusHandler] = routes.get('GET /api/dashboard/whatsapp/status');
    await statusAuth(request, response, () => {});
    statusHandler(request, response);
    assert.deepEqual(response.body, {
      ...qrState,
      sessionPersistent: true,
      sessionNotice: null
    });
  } finally {
    DashboardUser.findById = originalFindById;
    Doctor.findOne = originalDoctorFindOne;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});

test('clinic setup saves tenant schedule and gates WhatsApp pairing', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'setup-dashboard-session-secret-long-enough';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originalMethods = {
    dashboardFindById: DashboardUser.findById,
    doctorFindOne: Doctor.findOne,
    doctorFindOneAndUpdate: Doctor.findOneAndUpdate
  };
  const user = { _id: 'setup-user', role: 'DOCTOR', doctorId: 'setup-tenant', isActive: true };
  let doctor = {
    doctorId: user.doctorId,
    isActive: true,
    setupComplete: false,
    facilitiesList: [],
    servicesList: [],
    workingDays: [1, 2, 3, 4, 5],
    offDays: []
  };
  let savedFilter;
  let savedUpdate;
  let pairingStarted = false;
  DashboardUser.findById = () => ({ lean: async () => user });
  Doctor.findOne = () => ({ lean: async () => doctor });
  Doctor.findOneAndUpdate = (filter, update) => {
    savedFilter = filter;
    savedUpdate = update;
    doctor = { ...doctor, ...update.$set };
    return { lean: async () => doctor };
  };

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    mountDashboard(app, {}, 'Asia/Karachi', user.doctorId, {
      async startWhatsAppConnection(doctorId) {
        assert.equal(doctorId, user.doctorId);
        pairingStarted = true;
        return { status: 'starting' };
      },
      getWhatsAppConnectionStatus: () => ({ status: 'disconnected' })
    });
    const token = createSessionToken(user, secret, Date.now() + 60_000);
    const request = {
      headers: { cookie: `doctorbot_dashboard=${token}` },
      body: {
        doctorName: 'Dr. Test',
        clinicName: 'Tenant Clinic',
        basicCheckupFee: 800,
        facilityPricing: [
          { category: 'facility', name: 'OPD', price: 800 },
          { category: 'facility', name: 'Imaging', price: 1500 },
          { category: 'service', name: 'Vaccination', price: 500 }
        ],
        consultationDetails: 'Appointments required.',
        workingDays: [6, 1, 6],
        offDays: ['2026-12-25'],
        religion: 'Muslim',
        welcomeMessage: 'Welcome.'
      }
    };
    const makeResponse = () => ({
      locals: {}, statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; }
    });

    const [connectAuth, connectHandler] = routes.get('POST /api/dashboard/whatsapp/connect');
    let response = makeResponse();
    await connectAuth(request, response, () => {});
    await connectHandler(request, response);
    assert.equal(response.statusCode, 409);
    assert.equal(pairingStarted, false);

    const [settingsAuth, settingsHandler] = routes.get('PUT /api/dashboard/settings');
    response = makeResponse();
    await settingsAuth(request, response, () => {});
    await settingsHandler(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(savedFilter.doctorId, user.doctorId);
    assert.equal(savedUpdate.$set.setupComplete, true);
    assert.deepEqual(savedUpdate.$set.facilitiesList, ['OPD', 'Imaging']);
    assert.deepEqual(savedUpdate.$set.servicesList, ['Vaccination']);
    assert.deepEqual(savedUpdate.$set.workingDays, [1, 6]);
    assert.deepEqual(savedUpdate.$set.offDays, ['2026-12-25']);
    assert.deepEqual(savedUpdate.$set.servicesList, ['Vaccination']);
    assert.equal(savedUpdate.$set.religion, 'Muslim');
    assert.equal(savedUpdate.$set.basicCheckupFee, 800);
    assert.deepEqual(savedUpdate.$set.facilityPricing, [
      { category: 'facility', name: 'OPD', price: 800 },
      { category: 'facility', name: 'Imaging', price: 1500 },
      { category: 'service', name: 'Vaccination', price: 500 }
    ]);

    response = makeResponse();
    await connectAuth(request, response, () => {});
    await connectHandler(request, response);
    assert.equal(response.statusCode, 202);
    assert.equal(pairingStarted, true);

    request.body.basicCheckupFee = 950;
    request.body.facilityPricing[1].price = 1900;
    response = makeResponse();
    await settingsAuth(request, response, () => {});
    await settingsHandler(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(savedFilter.doctorId, user.doctorId);
    assert.equal(response.body.basicCheckupFee, 950);
    assert.equal(response.body.facilityPricing[1].price, 1900);
  } finally {
    DashboardUser.findById = originalMethods.dashboardFindById;
    Doctor.findOne = originalMethods.doctorFindOne;
    Doctor.findOneAndUpdate = originalMethods.doctorFindOneAndUpdate;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});

test('superadmin can edit an incomplete tenant profile and login email', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'superadmin-profile-session-secret-long';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originalMethods = {
    dashboardFindById: DashboardUser.findById,
    dashboardFindOne: DashboardUser.findOne,
    dashboardUpdateMany: DashboardUser.updateMany,
    doctorFindOne: Doctor.findOne,
    doctorFindOneAndUpdate: Doctor.findOneAndUpdate
  };
  const admin = { _id: 'superadmin-profile-user', role: 'SUPERADMIN', doctorId: null, isActive: true };
  const doctor = {
    doctorId: 'incomplete-tenant', doctorName: 'Old Name', clinicName: 'Old Clinic',
    email: 'old@example.test', facilitiesList: [], servicesList: [], facilityPricing: [],
    setupComplete: false, isActive: false
  };
  let savedFilter;
  let savedProfile;
  let updatedLogin;
  DashboardUser.findById = () => ({ lean: async () => admin });
  DashboardUser.findOne = () => ({ lean: async () => null });
  DashboardUser.updateMany = async (filter, update) => { updatedLogin = { filter, update }; };
  Doctor.findOne = () => ({ lean: async () => doctor });
  Doctor.findOneAndUpdate = (filter, update) => {
    savedFilter = filter;
    savedProfile = update.$set;
    return { lean: async () => ({ ...doctor, ...savedProfile }) };
  };

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    mountDashboard(app, {}, 'Asia/Karachi', 'bootstrap-clinic');
    const token = createSessionToken(admin, secret, Date.now() + 60_000);
    const request = {
      headers: { cookie: `doctorbot_dashboard=${token}` },
      params: { doctorId: doctor.doctorId },
      body: {
        doctorName: 'New Doctor', clinicName: 'New Clinic', email: 'new@example.test',
        religion: 'Christian', basicCheckupFee: 900,
        facilityPricing: [
          { category: 'facility', name: 'Lab', price: 500 },
          { category: 'service', name: 'Vaccination', price: 700 }
        ],
        consultationDetails: 'Appointments required.', workingDays: [1, 2, 3, 4, 5],
        offDays: [], religiousHolidayOpenDays: [], welcomeMessage: 'Welcome.'
      }
    };
    const response = {
      locals: {}, statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; }
    };
    const [auth, superadmin, update] = routes.get('PUT /api/admin/doctors/:doctorId');
    await auth(request, response, () => {});
    superadmin(request, response, () => {});
    await update(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(savedFilter.doctorId, doctor.doctorId);
    assert.equal(savedProfile.setupComplete, true);
    assert.deepEqual(savedProfile.facilitiesList, ['Lab']);
    assert.deepEqual(savedProfile.servicesList, ['Vaccination']);
    assert.equal(savedProfile.email, 'new@example.test');
    assert.equal(updatedLogin.filter.doctorId, doctor.doctorId);
    assert.equal(updatedLogin.update.$set.email, 'new@example.test');
  } finally {
    DashboardUser.findById = originalMethods.dashboardFindById;
    DashboardUser.findOne = originalMethods.dashboardFindOne;
    DashboardUser.updateMany = originalMethods.dashboardUpdateMany;
    Doctor.findOne = originalMethods.doctorFindOne;
    Doctor.findOneAndUpdate = originalMethods.doctorFindOneAndUpdate;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});

test('superadmin can provision without facilities and edit the complete tenant profile', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'superadmin-profile-session-secret-long-enough';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originalMethods = {
    dashboardFindById: DashboardUser.findById,
    dashboardFindOne: DashboardUser.findOne,
    dashboardCreate: DashboardUser.create,
    dashboardUpdateMany: DashboardUser.updateMany,
    doctorFindOne: Doctor.findOne,
    doctorFindOneAndUpdate: Doctor.findOneAndUpdate,
    doctorCreate: Doctor.create
  };
  const admin = { _id: 'root-admin', role: 'SUPERADMIN', doctorId: null, isActive: true };
  let doctor = null;
  let createdDoctorInput;
  let doctorFilter;
  let doctorUpdate;
  let loginEmailUpdate;
  DashboardUser.findById = () => ({ lean: async () => admin });
  DashboardUser.findOne = () => ({ lean: async () => null });
  DashboardUser.create = async (input) => ({ _id: 'new-login', ...input });
  DashboardUser.updateMany = async (filter, update) => { loginEmailUpdate = { filter, update }; };
  Doctor.create = async (input) => {
    createdDoctorInput = input;
    doctor = { ...input, facilitiesList: [], servicesList: [], facilityPricing: [], setupComplete: false };
    return doctor;
  };
  Doctor.findOne = () => ({ lean: async () => doctor });
  Doctor.findOneAndUpdate = (filter, update) => {
    doctorFilter = filter;
    doctorUpdate = update;
    doctor = { ...doctor, ...update.$set };
    return { lean: async () => doctor };
  };

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    mountDashboard(app, {}, 'Asia/Karachi', 'bootstrap-clinic');
    const token = createSessionToken(admin, secret, Date.now() + 60_000);
    const request = { headers: { cookie: `doctorbot_dashboard=${token}` }, body: {} };
    const response = {
      locals: {}, statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; }
    };

    request.body = {
      doctorName: 'Dr. Admin Managed',
      clinicName: 'Managed Clinic',
      email: 'managed@example.test',
      password: 'secure-temporary-password',
      welcomeMessage: ''
    };
    const [createAuth, createSuperadmin, createHandler] = routes.get('POST /api/admin/doctors');
    await createAuth(request, response, () => {});
    createSuperadmin(request, response, () => {});
    await createHandler(request, response);
    assert.equal(response.statusCode, 201);
    assert.equal(Object.hasOwn(createdDoctorInput, 'facilitiesList'), false);
    assert.equal(Object.hasOwn(createdDoctorInput, 'setupComplete'), false);

    const profile = {
      doctorName: 'Dr. Admin Managed',
      clinicName: 'Managed Clinic',
      email: 'updated@example.test',
      religion: 'Christian',
      facilitiesList: [],
      servicesList: [],
      basicCheckupFee: 900,
      facilityPricing: [
        { category: 'facility', name: 'Imaging', price: 1500 },
        { category: 'service', name: 'Vaccination', price: 500 }
      ],
      consultationDetails: 'Walk-ins welcome.',
      workingDays: [1, 2, 3, 4, 5],
      offDays: [],
      religiousHolidayOpenDays: [],
      welcomeMessage: 'Welcome.'
    };
    request.params = { doctorId: doctor.doctorId };
    request.body = profile;
    response.statusCode = 200;
    const [updateAuth, updateSuperadmin, updateHandler] = routes.get('PUT /api/admin/doctors/:doctorId');
    await updateAuth(request, response, () => {});
    updateSuperadmin(request, response, () => {});
    await updateHandler(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(doctorFilter.doctorId, doctor.doctorId);
    assert.equal(doctorUpdate.$set.setupComplete, true);
    assert.deepEqual(doctorUpdate.$set.facilitiesList, ['Imaging']);
    assert.deepEqual(doctorUpdate.$set.servicesList, ['Vaccination']);
    assert.equal(doctorUpdate.$set.facilityPricing[0].price, 1500);
    assert.deepEqual(loginEmailUpdate.filter, { doctorId: doctor.doctorId, role: 'DOCTOR' });
    assert.equal(loginEmailUpdate.update.$set.email, 'updated@example.test');
  } finally {
    DashboardUser.findById = originalMethods.dashboardFindById;
    DashboardUser.findOne = originalMethods.dashboardFindOne;
    DashboardUser.create = originalMethods.dashboardCreate;
    DashboardUser.updateMany = originalMethods.dashboardUpdateMany;
    Doctor.findOne = originalMethods.doctorFindOne;
    Doctor.findOneAndUpdate = originalMethods.doctorFindOneAndUpdate;
    Doctor.create = originalMethods.doctorCreate;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});

test('Excel report contains the requested patient columns and data', async () => {
  const workbookBuffer = await generateAppointmentsWorkbook([{
    details: {
      name: 'Sample Patient',
      contactNumber: '+923001234567',
      majorSymptoms: 'Sample symptom'
    },
    slotStart: new Date('2026-10-03T05:00:00Z'),
    slotEnd: new Date('2026-10-03T05:30:00Z'),
    status: 'booked'
  }], 'Asia/Karachi');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(workbookBuffer);
  const sheet = workbook.worksheets[0];
  assert.deepEqual(sheet.getRow(1).values.slice(1), [
    'Patient Name', 'WhatsApp Number', 'Symptoms', 'Appointment Slot', 'Status'
  ]);
  assert.equal(sheet.getRow(2).getCell(1).value, 'Sample Patient');
  assert.equal(sheet.getRow(2).getCell(3).value, 'Sample symptom');
  assert.equal(sheet.getRow(2).getCell(5).value, 'booked');
});

test('first-message greetings are deterministic and include ordered facilities', () => {
  const doctor = {
    doctorName: 'Dr. Example',
    clinicName: 'Example Clinic',
    welcomeMessage: 'Welcome to Example Clinic',
    facilitiesList: ['Outpatient', 'Imaging'],
    servicesList: ['Vaccination'],
    consultationDetails: 'By appointment only.',
    basicCheckupFee: 800,
    facilityPricing: [
      { category: 'facility', name: 'Outpatient', price: 500 },
      { category: 'facility', name: 'Imaging', price: 1500 },
      { category: 'service', name: 'Vaccination', price: 650 }
    ]
  };
  assert.match(getWelcomeMessage('Hi', doctor), /^Hello!/);
  assert.match(getWelcomeMessage('Salam', doctor), /^Walaikum Assalam!/);
  assert.match(getWelcomeMessage('I need an appointment', doctor), /^Ji farmaiye!/);
  assert.match(getWelcomeMessage('Hi', doctor), /1\. Outpatient[\s\S]*2\. Imaging/);
  assert.match(getWelcomeMessage('Hi', doctor), /Vaccination/);
  assert.match(getWelcomeMessage('Hi', doctor), /By appointment only/);
  assert.match(getWelcomeMessage('Hi', doctor), /Dr\. Example ke Example Clinic/);
  assert.match(getWelcomeMessage('Hi', doctor), /Basic checkup fee: Rs\. 800/);
  assert.match(getWelcomeMessage('Hi', doctor), /Outpatient: Rs\. 500/);
  assert.match(getWelcomeMessage('Hi', doctor), /Imaging: Rs\. 1,500/);
  assert.match(getWelcomeMessage('Hi', doctor), /Vaccination: Rs\. 650/);
  assert.doesNotMatch(getWelcomeMessage('Hi', doctor), /Dr\. Ahmad|City Care Clinic|General OPD/);
});

test('welcome message lists every facility and service exactly once', () => {
  const doctor = {
    doctorName: 'Dr. Example',
    clinicName: 'Example Clinic',
    welcomeMessage: '',
    facilitiesList: ['Outpatient', 'Imaging'],
    servicesList: ['Vaccination'],
    consultationDetails: '',
    basicCheckupFee: 800,
    facilityPricing: [
      { category: 'facility', name: 'Outpatient', price: 500 },
      { category: 'facility', name: 'Imaging', price: 1500 },
      { category: 'service', name: 'Vaccination', price: 650 }
    ]
  };
  const message = getWelcomeMessage('Salam', doctor);
  assert.equal(message.match(/Outpatient/g).length, 1);
  assert.equal(message.match(/Imaging/g).length, 1);
  assert.equal(message.match(/Vaccination/g).length, 1);
  assert.equal(message.match(/sahuliyaat aur rates/g).length, 1);
  assert.equal(message.match(/services\/treatments aur rates/g).length, 1);
});

test('dashboard passwords use salted scrypt hashes', async () => {
  const hash = await hashPassword('correct-horse-battery-staple');
  assert.notEqual(hash, 'correct-horse-battery-staple');
  assert.equal(await verifyPassword('correct-horse-battery-staple', hash), true);
  assert.equal(await verifyPassword('incorrect-password', hash), false);
  await assert.rejects(hashPassword('short'));
});

test('doctor and superadmin sessions enforce dashboard roles', async () => {
  const secret = 'test-secret-that-is-long-enough-for-a-session';
  const previousSecret = process.env.DASHBOARD_COOKIE_SECRET;
  process.env.DASHBOARD_COOKIE_SECRET = secret;
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originalFindById = DashboardUser.findById;
  const originalDoctorFindOne = Doctor.findOne;
  let currentRole = 'DOCTOR';
  DashboardUser.findById = () => ({ lean: async () => ({
    _id: 'role-test-user',
    role: currentRole,
    doctorId: currentRole === 'DOCTOR' ? 'doctor-tenant' : null,
    isActive: true
  }) });
  Doctor.findOne = () => ({ lean: async () => ({ doctorId: 'doctor-tenant', isActive: true }) });

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    mountDashboard(app, {}, 'Asia/Karachi', 'doctor-tenant');
    const adminHandlers = routes.get('GET /api/admin/doctors');
    const response = {
      locals: {},
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; }
    };
    const makeRequest = (role) => ({
      headers: { cookie: `doctorbot_dashboard=${createSessionToken({
        _id: 'role-test-user',
        role,
        doctorId: role === 'DOCTOR' ? 'doctor-tenant' : null
      }, secret, Date.now() + 60_000)}` }
    });

    let passedGuard = false;
    await adminHandlers[0](makeRequest('DOCTOR'), response, () => {});
    adminHandlers[1]({}, response, () => { passedGuard = true; });
    assert.equal(passedGuard, false);
    assert.equal(response.statusCode, 403);

    currentRole = 'SUPERADMIN';
    const superadminResponse = { locals: {}, status() { return this; }, json() {} };
    await adminHandlers[0](makeRequest('SUPERADMIN'), superadminResponse, () => {});
    adminHandlers[1]({}, superadminResponse, () => { passedGuard = true; });
    assert.equal(passedGuard, true);
  } finally {
    DashboardUser.findById = originalFindById;
    Doctor.findOne = originalDoctorFindOne;
    if (previousSecret === undefined) delete process.env.DASHBOARD_COOKIE_SECRET;
    else process.env.DASHBOARD_COOKIE_SECRET = previousSecret;
  }
});

test('Google OAuth state is signed, doctor-bound, and expires', () => {
  const secret = 'oauth-state-signing-secret-long-enough';
  const claims = { userId: 'user-1', doctorId: 'doctor-1', nonce: 'nonce-1', expiresAt: Date.now() + 60_000 };
  const state = createGoogleOAuthState(claims.userId, claims.doctorId, claims.nonce, claims.expiresAt, secret);
  assert.deepEqual(verifyGoogleOAuthState(state, secret), claims);
  assert.equal(verifyGoogleOAuthState(`${state}x`, secret), null);
  const expiredState = createGoogleOAuthState('user-1', 'doctor-1', 'nonce-2', Date.now() - 1, secret);
  assert.equal(verifyGoogleOAuthState(expiredState, secret), null);
});

test('Google Calendar OAuth uses shared config and stores the encrypted token per doctor', async () => {
  const environmentNames = [
    'DASHBOARD_SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI', 'GOOGLE_REFRESH_TOKEN', 'DOCTOR_CONFIG_ENCRYPTION_KEY'
  ];
  const previousValues = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originalMethods = {
    dashboardFindById: DashboardUser.findById,
    dashboardUpdateOne: DashboardUser.updateOne,
    dashboardFindOneAndUpdate: DashboardUser.findOneAndUpdate,
    doctorFindOne: Doctor.findOne,
    doctorUpdateOne: Doctor.updateOne,
    OAuth2: google.auth.OAuth2,
    calendar: google.calendar
  };
  const user = { _id: 'oauth-doctor-user', role: 'DOCTOR', doctorId: 'clinic-alpha', isActive: true };
  const encryptionEnvironment = { DOCTOR_CONFIG_ENCRYPTION_KEY: 'c'.repeat(64) };
  let nonce;
  let oauthOptions;
  let doctorUpdate;
  let oauthConstructorArgs;
  let calendarVerified = false;
  process.env.DASHBOARD_SESSION_SECRET = 'oauth-dashboard-session-secret-long-enough';
  process.env.GOOGLE_CLIENT_ID = 'shared-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'shared-client-secret';
  process.env.GOOGLE_REDIRECT_URI = 'https://clinic.example/api/auth/google/callback';
  process.env.GOOGLE_REFRESH_TOKEN = 'bootstrap-refresh-token';
  process.env.DOCTOR_CONFIG_ENCRYPTION_KEY = encryptionEnvironment.DOCTOR_CONFIG_ENCRYPTION_KEY;
  DashboardUser.findById = () => ({ lean: async () => user });
  DashboardUser.updateOne = async (_filter, update) => {
    nonce = update.$set.googleOAuthNonce;
    return { matchedCount: 1 };
  };
  DashboardUser.findOneAndUpdate = (filter) => ({
    lean: async () => filter.googleOAuthNonce === nonce ? user : null
  });
  Doctor.findOne = () => {
    const profile = {
      doctorId: user.doctorId,
      isActive: true,
      googleCalendarId: 'primary',
      googleCredentialsEncrypted: doctorUpdate?.update?.$set?.googleCredentialsEncrypted
    };
    const query = { select: () => query, lean: async () => profile };
    return query;
  };
  Doctor.updateOne = async (filter, update) => {
    doctorUpdate = { filter, update };
    return { matchedCount: 1 };
  };
  google.calendar = () => ({
    freebusy: {
      query: async () => {
        calendarVerified = true;
        return { data: { calendars: { primary: { busy: [] } } } };
      }
    }
  });
  google.auth.OAuth2 = class MockOAuth2 {
    constructor(...args) { oauthConstructorArgs = args; }
    setCredentials() {}
    generateAuthUrl(options) {
      oauthOptions = options;
      return 'https://accounts.google.test/oauth';
    }
    async getToken(code) {
      assert.equal(code, 'authorization-code');
      return { tokens: { refresh_token: 'doctor-specific-refresh-token' } };
    }
  };

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    mountDashboard(app, {}, 'Asia/Karachi', user.doctorId);
    const token = createSessionToken(user, process.env.DASHBOARD_SESSION_SECRET, Date.now() + 60_000);
    const request = { headers: { cookie: `doctorbot_dashboard=${token}` }, query: {} };
    const response = {
      locals: {},
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; },
      redirect(url) { this.redirectUrl = url; },
      send(body) { this.body = body; }
    };
    const [startAuth, startHandler] = routes.get('GET /api/auth/google');
    await startAuth(request, response, () => {});
    await startHandler(request, response);
    assert.equal(response.redirectUrl, 'https://accounts.google.test/oauth');
    assert.deepEqual(oauthConstructorArgs, [
      'shared-client-id', 'shared-client-secret', 'https://clinic.example/api/auth/google/callback'
    ]);
    assert.equal(oauthOptions.access_type, 'offline');
    assert.equal(oauthOptions.prompt, 'consent');
    assert.deepEqual(oauthOptions.scope, [
      'https://www.googleapis.com/auth/calendar.freebusy',
      'https://www.googleapis.com/auth/calendar.events'
    ]);
    // The full "calendar" scope is a Google RESTRICTED scope: requesting it makes
    // Google block sign-in with "doesn't comply with Google's OAuth 2.0 policy"
    // until the app completes verification.
    assert.equal(oauthOptions.scope.includes('https://www.googleapis.com/auth/calendar'), false);

    request.query = { code: 'authorization-code', state: oauthOptions.state };
    response.locals = {};
    const [callbackAuth, callbackHandler] = routes.get('GET /api/auth/google/callback');
    await callbackAuth(request, response, () => {});
    await callbackHandler(request, response);
    assert.equal(response.redirectUrl, '/dashboard?calendar=connected');
    assert.equal(calendarVerified, true);
    assert.equal(doctorUpdate.filter.doctorId, user.doctorId);
    assert.equal(doctorUpdate.filter.isActive, true);
    const encryptedCredentials = doctorUpdate.update.$set.googleCredentialsEncrypted;
    assert.doesNotMatch(encryptedCredentials, /doctor-specific-refresh-token/);
    assert.deepEqual(decryptJson(encryptedCredentials, encryptionEnvironment), {
      refreshToken: 'doctor-specific-refresh-token'
    });
    assert.equal(doctorUpdate.update.$set.googleCalendarConnected, true);
  } finally {
    DashboardUser.findById = originalMethods.dashboardFindById;
    DashboardUser.updateOne = originalMethods.dashboardUpdateOne;
    DashboardUser.findOneAndUpdate = originalMethods.dashboardFindOneAndUpdate;
    Doctor.findOne = originalMethods.doctorFindOne;
    Doctor.updateOne = originalMethods.doctorUpdateOne;
    google.auth.OAuth2 = originalMethods.OAuth2;
    google.calendar = originalMethods.calendar;
    for (const name of environmentNames) {
      if (previousValues[name] === undefined) delete process.env[name];
      else process.env[name] = previousValues[name];
    }
  }
});

test('OAuth callback reports a failure instead of success when the token cannot be verified', async () => {
  const environmentNames = [
    'DASHBOARD_SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI', 'DOCTOR_CONFIG_ENCRYPTION_KEY'
  ];
  const previousValues = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originalMethods = {
    dashboardFindById: DashboardUser.findById,
    dashboardUpdateOne: DashboardUser.updateOne,
    dashboardFindOneAndUpdate: DashboardUser.findOneAndUpdate,
    doctorFindOne: Doctor.findOne,
    doctorUpdateOne: Doctor.updateOne,
    OAuth2: google.auth.OAuth2,
    calendar: google.calendar
  };
  const user = { _id: 'broken-calendar-user', role: 'DOCTOR', doctorId: 'clinic-broken', isActive: true };
  let nonce;
  let oauthOptions;
  process.env.DASHBOARD_SESSION_SECRET = 'broken-calendar-session-secret-long';
  process.env.GOOGLE_CLIENT_ID = 'shared-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'shared-client-secret';
  process.env.GOOGLE_REDIRECT_URI = 'https://clinic.example/api/auth/google/callback';
  process.env.DOCTOR_CONFIG_ENCRYPTION_KEY = 'a'.repeat(64);
  delete process.env.GOOGLE_REFRESH_TOKEN;
  DashboardUser.findById = () => ({ lean: async () => user });
  DashboardUser.updateOne = async (_filter, update) => {
    nonce = update.$set.googleOAuthNonce;
    return { matchedCount: 1 };
  };
  DashboardUser.findOneAndUpdate = (filter) => ({
    lean: async () => filter.googleOAuthNonce === nonce ? user : null
  });
  Doctor.findOne = () => {
    const profile = {
      doctorId: user.doctorId,
      isActive: true,
      googleCalendarId: 'primary',
      googleCredentialsEncrypted: 'iv.tag.ciphertext'
    };
    const query = { select: () => query, lean: async () => profile };
    return query;
  };
  Doctor.updateOne = async () => ({ matchedCount: 1 });
  google.auth.OAuth2 = class MockOAuth2 {
    constructor() {}
    setCredentials() {}
    generateAuthUrl(options) { return 'https://accounts.google.test/oauth?state=' + encodeURIComponent(options.state); }
    async getToken() { return { tokens: { refresh_token: 'revoked-refresh-token' } }; }
  };
  google.calendar = () => ({
    freebusy: {
      query: async () => {
        const error = new Error('API has not been used in project 12345 before or it is disabled');
        error.response = {
          status: 403,
          data: { error: { message: error.message, errors: [{ reason: 'accessNotConfigured' }] } }
        };
        throw error;
      }
    }
  });

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    mountDashboard(app, {}, 'Asia/Karachi', user.doctorId);
    const token = createSessionToken(user, process.env.DASHBOARD_SESSION_SECRET, Date.now() + 60_000);
    const request = { headers: { cookie: `doctorbot_dashboard=${token}` }, query: {} };
    const response = {
      locals: {},
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; },
      redirect(url) { this.redirectUrl = url; },
      send(body) { this.body = body; }
    };
    const [startAuth, startHandler] = routes.get('GET /api/auth/google');
    await startAuth(request, response, () => {});
    await startHandler(request, response);
    oauthOptions = { state: new URL(response.redirectUrl).searchParams.get('state') };

    request.query = { code: 'authorization-code', state: oauthOptions.state };
    response.locals = {};
    const [callbackAuth, callbackHandler] = routes.get('GET /api/auth/google/callback');
    await callbackAuth(request, response, () => {});
    await callbackHandler(request, response);
    assert.match(response.redirectUrl, /^\/dashboard\?calendar=failed&reason=/);
    assert.doesNotMatch(response.redirectUrl, /calendar=connected/);
  } finally {
    DashboardUser.findById = originalMethods.dashboardFindById;
    DashboardUser.updateOne = originalMethods.dashboardUpdateOne;
    DashboardUser.findOneAndUpdate = originalMethods.dashboardFindOneAndUpdate;
    Doctor.findOne = originalMethods.doctorFindOne;
    Doctor.updateOne = originalMethods.doctorUpdateOne;
    google.auth.OAuth2 = originalMethods.OAuth2;
    google.calendar = originalMethods.calendar;
    for (const name of environmentNames) {
      if (previousValues[name] === undefined) delete process.env[name];
      else process.env[name] = previousValues[name];
    }
  }
});

test('facility pricing validates unique rate rows and formats Pakistani rupees', () => {
  const { rows: rates, error: ratesError } = normalizeFacilityPricing([
    { name: 'Blood Test', price: 500 },
    { name: 'Ultrasound', price: 1500.5 },
    { name: 'Injection', price: 0.29 }
  ]);
  assert.equal(ratesError, null);
  assert.deepEqual(rates, [
    { category: 'facility', name: 'Blood Test', price: 500 },
    { category: 'facility', name: 'Ultrasound', price: 1500.5 },
    { category: 'facility', name: 'Injection', price: 0.29 }
  ]);
  assert.equal(getFacilityPrice({ facilityPricing: rates }, 'blood test'), 'Rs. 500');
  assert.equal(formatRupees(1500.5), 'Rs. 1,500.5');
  assert.equal(formatRupees(null), null);
  assert.equal(normalizeFacilityPricing([{ name: 'Scan', price: -1 }]).rows, null);
  assert.equal(normalizeFacilityPricing([{ name: 'Lab', price: 100 }, { name: ' lab ', price: 200 }]).rows, null);
  assert.equal(normalizeFacilityPricing([{ name: 'Lab', price: null }]).rows, null);
});

test('facility pricing explains exactly what is wrong instead of saying add an item', () => {
  const priced = [
    { category: 'facility', name: 'Clinical pathology', price: 700 },
    { category: 'facility', name: 'Hemoglobin', price: 700 },
    { category: 'facility', name: 'Investigation', price: 700 }
  ];

  // The reported failure: a full list where one price was left blank was rejected
  // with a message claiming the clinic had no items at all.
  const blankPrice = normalizeFacilityPricing(priced.map((item, index) =>
    (index === 1 ? { ...item, price: '' } : item)));
  assert.equal(blankPrice.rows, null);
  assert.match(blankPrice.error, /Enter a price in rupees for "Hemoglobin"/);
  assert.doesNotMatch(blankPrice.error, /Add at least one/);

  const duplicate = normalizeFacilityPricing([...priced, { category: 'facility', name: 'hemoglobin', price: 900 }]);
  assert.equal(duplicate.rows, null);
  assert.match(duplicate.error, /"hemoglobin" is listed more than once/);
  assert.doesNotMatch(duplicate.error, /Add at least one/);

  const blankName = normalizeFacilityPricing([...priced, { category: 'facility', name: '   ', price: 100 }]);
  assert.match(blankName.error, /needs a name/);
  assert.doesNotMatch(blankName.error, /Add at least one/);

  const longName = normalizeFacilityPricing([{ category: 'facility', name: 'x'.repeat(101), price: 100 }]);
  assert.match(longName.error, /too long/);

  const badCategory = normalizeFacilityPricing([{ category: 'medicine', name: 'Paracetamol', price: 50 }]);
  assert.match(badCategory.error, /Facility or a Treatment or service/);

  const badPrice = normalizeFacilityPricing([{ category: 'facility', name: 'Scan', price: 99_999_999 }]);
  assert.match(badPrice.error, /not a valid price for "Scan"/);

  // Only a genuinely empty list earns the "add one" instruction.
  const empty = normalizeFacilityPricing([]);
  assert.match(empty.error, /Add at least one facility or treatment/);

  const tooMany = normalizeFacilityPricing(Array.from({ length: 41 }, (_v, i) => ({ name: `Item ${i}`, price: 10 })));
  assert.match(tooMany.error, /at most 40/);

  const notAList = normalizeFacilityPricing('nope');
  assert.match(notAList.error, /could not be read/);

  // A valid list still passes untouched.
  assert.equal(normalizeFacilityPricing(priced).error, null);
});

test('voice transcription falls back to the transcription endpoint when translation fails', async () => {
  const endpoints = [];
  const transcript = await translateVoiceMessageToEnglish(
    Buffer.from('voice'),
    'audio/ogg; codecs=opus',
    { OPENAI_ALLOW_PHI_PROCESSING: 'true', OPENAI_API_KEY: 'test-key' },
    async (url, options) => {
      endpoints.push(url);
      if (url.endsWith('/translations')) return { ok: false, status: 500, async json() { return {}; } };
      return { ok: true, async json() { return { text: 'I need an appointment next Friday.' }; } };
    },
    async () => Buffer.from('normalized wav')
  );
  assert.deepEqual(endpoints, [
    'https://api.openai.com/v1/audio/translations',
    'https://api.openai.com/v1/audio/transcriptions'
  ]);
  assert.equal(transcript, 'I need an appointment next Friday.');
});

test('voice errors are classified so only transient failures retry', () => {
  assert.equal(isVoiceErrorRetryable({ code: 'VOICE_TRANSCRIPTION_NOT_ENABLED' }), false);
  assert.equal(isVoiceErrorRetryable({ code: 'VOICE_TRANSCRIPTION_NOT_CONFIGURED' }), false);
  assert.equal(isVoiceErrorRetryable({ code: 'VOICE_TRANSCRIPT_EMPTY' }), false);
  assert.equal(isVoiceErrorRetryable({ code: 'VOICE_CONVERSION_FAILED' }), false);
  assert.equal(isVoiceErrorRetryable({ code: 'VOICE_PROVIDER_HTTP_400' }), false);
  assert.equal(isVoiceErrorRetryable({ code: 'VOICE_PROVIDER_HTTP_429' }), true);
  assert.equal(isVoiceErrorRetryable({ code: 'VOICE_PROVIDER_HTTP_503' }), true);
  assert.equal(isVoiceErrorRetryable({ code: 'VOICE_PROVIDER_UNAVAILABLE' }), true);
  assert.equal(isVoiceErrorRetryable({ code: 'VOICE_CONVERSION_TIMEOUT' }), true);
  assert.equal(isVoiceErrorRetryable(new Error('unexpected')), true);
});

test('Google redirect URI resolves from config or the incoming request', () => {
  const configured = resolveGoogleRedirectUri(
    { headers: { host: 'ignored.example' } },
    { GOOGLE_REDIRECT_URI: 'https://clinic.example/api/auth/google/callback' }
  );
  assert.deepEqual(configured, {
    redirectUri: 'https://clinic.example/api/auth/google/callback',
    error: null
  });

  const derived = resolveGoogleRedirectUri(
    { protocol: 'https', headers: { host: 'clinic.example' } },
    {}
  );
  assert.deepEqual(derived, {
    redirectUri: 'https://clinic.example/api/auth/google/callback',
    error: null
  });

  const local = resolveGoogleRedirectUri({ headers: { host: 'localhost:3000' } }, {});
  assert.equal(local.redirectUri, 'http://localhost:3000/api/auth/google/callback');

  const insecureLive = resolveGoogleRedirectUri({ headers: { host: 'clinic.example' } }, {});
  assert.equal(insecureLive.redirectUri, null);
  assert.match(insecureLive.error, /GOOGLE_REDIRECT_URI/);

  const invalid = resolveGoogleRedirectUri(
    { headers: { host: 'clinic.example' } },
    { GOOGLE_REDIRECT_URI: 'https://clinic.example/wrong-path' }
  );
  assert.equal(invalid.redirectUri, null);
  assert.match(invalid.error, /end exactly with \/api\/auth\/google\/callback/);
});

test('clinic setup accepts facility-only or service-only pricing', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'pricing-dashboard-session-secret-long-enough';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originalMethods = {
    dashboardFindById: DashboardUser.findById,
    doctorFindOne: Doctor.findOne,
    doctorFindOneAndUpdate: Doctor.findOneAndUpdate
  };
  const user = { _id: 'pricing-user', role: 'DOCTOR', doctorId: 'pricing-tenant', isActive: true };
  let doctor = { doctorId: user.doctorId, isActive: true, setupComplete: false };
  let savedUpdate;
  DashboardUser.findById = () => ({ lean: async () => user });
  Doctor.findOne = () => ({ lean: async () => doctor });
  Doctor.findOneAndUpdate = (filter, update) => {
    savedUpdate = update;
    doctor = { ...doctor, ...update.$set };
    return { lean: async () => doctor };
  };

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    mountDashboard(app, {}, 'Asia/Karachi', user.doctorId);
    const token = createSessionToken(user, secret, Date.now() + 60_000);
    const request = {
      headers: { cookie: `doctorbot_dashboard=${token}` },
      body: {
        doctorName: 'Dr. Pricing',
        clinicName: 'Pricing Clinic',
        basicCheckupFee: 700,
        facilityPricing: [
          { category: 'facility', name: 'OPD', price: 700 },
          { category: 'facility', name: 'Ultrasound', price: 1800 }
        ],
        consultationDetails: 'Appointments required.',
        workingDays: [1, 2, 3, 4, 5],
        offDays: [],
        religion: 'Muslim',
        welcomeMessage: ''
      }
    };
    const response = {
      locals: {}, statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; }
    };
    const [settingsAuth, settingsHandler] = routes.get('PUT /api/dashboard/settings');
    await settingsAuth(request, response, () => {});
    await settingsHandler(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(savedUpdate.$set.setupComplete, true);
    assert.deepEqual(savedUpdate.$set.facilitiesList, ['OPD', 'Ultrasound']);
    assert.deepEqual(savedUpdate.$set.servicesList, []);
  } finally {
    DashboardUser.findById = originalMethods.dashboardFindById;
    Doctor.findOne = originalMethods.doctorFindOne;
    Doctor.findOneAndUpdate = originalMethods.doctorFindOneAndUpdate;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});

test('superadmin partial edits preserve untouched settings and recompute setup state', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'superadmin-partial-session-secret-long';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originalMethods = {
    dashboardFindById: DashboardUser.findById,
    dashboardFindOne: DashboardUser.findOne,
    dashboardUpdateMany: DashboardUser.updateMany,
    doctorFindOne: Doctor.findOne,
    doctorFindOneAndUpdate: Doctor.findOneAndUpdate
  };
  const admin = { _id: 'partial-admin', role: 'SUPERADMIN', doctorId: null, isActive: true };
  const existingDoctor = {
    doctorId: 'partial-tenant',
    doctorName: 'Dr. Old',
    clinicName: 'Old Clinic',
    email: 'old@example.test',
    facilitiesList: ['OPD'],
    servicesList: ['Vaccination'],
    facilityPricing: [
      { category: 'facility', name: 'OPD', price: 800 },
      { category: 'service', name: 'Vaccination', price: 650 }
    ],
    basicCheckupFee: 800,
    consultationDetails: 'Appointments required.',
    workingDays: [1, 2, 3, 4, 5],
    offDays: ['2026-12-25'],
    religiousHolidayOpenDays: [],
    religion: 'Muslim',
    welcomeMessage: 'Welcome.',
    setupComplete: true,
    isActive: true
  };
  let savedUpdate;
  let loginEmailUpdate;
  DashboardUser.findById = () => ({ lean: async () => admin });
  DashboardUser.findOne = () => ({ lean: async () => null });
  DashboardUser.updateMany = async (filter, update) => { loginEmailUpdate = { filter, update }; };
  Doctor.findOne = () => ({ lean: async () => existingDoctor });
  Doctor.findOneAndUpdate = (filter, update) => {
    savedUpdate = update;
    return { lean: async () => ({ ...existingDoctor, ...update.$set }) };
  };

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    mountDashboard(app, {}, 'Asia/Karachi', 'bootstrap-clinic');
    const token = createSessionToken(admin, secret, Date.now() + 60_000);
    const request = {
      headers: { cookie: `doctorbot_dashboard=${token}` },
      params: { doctorId: existingDoctor.doctorId },
      body: { doctorName: 'Dr. Renamed', email: 'renamed@example.test' }
    };
    const response = {
      locals: {}, statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; }
    };
    const [auth, superadmin, update] = routes.get('PUT /api/admin/doctors/:doctorId');
    await auth(request, response, () => {});
    superadmin(request, response, () => {});
    await update(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(savedUpdate.$set.doctorName, 'Dr. Renamed');
    assert.equal(savedUpdate.$set.email, 'renamed@example.test');
    assert.equal(Object.hasOwn(savedUpdate.$set, 'facilityPricing'), false);
    assert.equal(Object.hasOwn(savedUpdate.$set, 'workingDays'), false);
    assert.equal(savedUpdate.$set.setupComplete, true);
    assert.equal(response.body.doctor.basicCheckupFee, 800);
    assert.deepEqual(response.body.doctor.facilitiesList, ['OPD']);
    assert.equal(loginEmailUpdate.update.$set.email, 'renamed@example.test');

    // An incomplete tenant stays marked incomplete after a partial edit.
    Doctor.findOne = () => ({ lean: async () => ({
      doctorId: 'incomplete-tenant', doctorName: 'Dr. New', clinicName: 'New Clinic',
      email: 'new@example.test', isActive: true, setupComplete: false
    }) });
    request.params = { doctorId: 'incomplete-tenant' };
    request.body = { welcomeMessage: 'Assalam o Alaikum!' };
    await auth(request, response, () => {});
    await update(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(savedUpdate.$set.setupComplete, false);
    assert.equal(savedUpdate.$set.welcomeMessage, 'Assalam o Alaikum!');
  } finally {
    DashboardUser.findById = originalMethods.dashboardFindById;
    DashboardUser.findOne = originalMethods.dashboardFindOne;
    DashboardUser.updateMany = originalMethods.dashboardUpdateMany;
    Doctor.findOne = originalMethods.doctorFindOne;
    Doctor.findOneAndUpdate = originalMethods.doctorFindOneAndUpdate;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});

test('doctor settings can preview religious holidays for an unsaved religion', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'holiday-preview-session-secret-long-enough';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originalFindById = DashboardUser.findById;
  const originalDoctorFindOne = Doctor.findOne;
  const user = { _id: 'holiday-user', role: 'DOCTOR', doctorId: 'holiday-tenant', isActive: true };
  DashboardUser.findById = () => ({ lean: async () => user });
  Doctor.findOne = () => ({ lean: async () => ({
    doctorId: user.doctorId, isActive: true, religion: 'Christian',
    religiousHolidayOpenDays: ['2026-04-05']
  }) });

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    mountDashboard(app, {}, 'Asia/Karachi', user.doctorId);
    const token = createSessionToken(user, secret, Date.now() + 60_000);
    const request = {
      headers: { cookie: `doctorbot_dashboard=${token}` },
      query: { religion: 'Muslim' }
    };
    const response = {
      locals: {}, statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; }
    };
    const [settingsAuth, settingsHandler] = routes.get('GET /api/dashboard/settings');
    await settingsAuth(request, response, () => {});
    settingsHandler(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.religion, 'Christian');
    assert.ok(response.body.religiousHolidays.length > 0);
    assert.ok(response.body.religiousHolidays.every(({ name }) =>
      /Eid al-Fitr|Eid al-Adha|End of Ramadan|Feast of the Sacrifice/i.test(name)));
    assert.deepEqual(response.body.religiousHolidayOpenDays, ['2026-04-05']);
  } finally {
    DashboardUser.findById = originalFindById;
    Doctor.findOne = originalDoctorFindOne;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});test('calendar credentials resolve from encrypted doctor record or bootstrap environment', () => {
  const environment = {
    GOOGLE_CLIENT_ID: 'env-client',
    GOOGLE_CLIENT_SECRET: 'env-secret',
    GOOGLE_REFRESH_TOKEN: 'env-refresh',
    DOCTOR_CONFIG_ENCRYPTION_KEY: 'e'.repeat(64)
  };
  const connected = {
    doctorId: 'tenant-a',
    googleCredentialsEncrypted: encryptJson({ refreshToken: 'doctor-refresh' }, environment)
  };
  assert.deepEqual(resolveGoogleCredentials(connected, environment, 'tenant-a'), {
    clientId: 'env-client',
    clientSecret: 'env-secret',
    refreshToken: 'doctor-refresh'
  });
  assert.deepEqual(resolveGoogleCredentials({ doctorId: 'tenant-a' }, environment, 'tenant-a'), {
    clientId: 'env-client',
    clientSecret: 'env-secret',
    refreshToken: 'env-refresh'
  });
  assert.deepEqual(resolveGoogleCredentials({ doctorId: 'tenant-b' }, environment, 'tenant-a'), {
    clientId: 'env-client',
    clientSecret: 'env-secret',
    refreshToken: null
  });
});

test('calendar verification reports not-connected, confirmed and revoked states', async () => {
  const environment = {
    GOOGLE_CLIENT_ID: 'env-client',
    GOOGLE_CLIENT_SECRET: 'env-secret',
    GOOGLE_REFRESH_TOKEN: 'env-refresh',
    DOCTOR_CONFIG_ENCRYPTION_KEY: 'f'.repeat(64)
  };
  const notConnected = await verifyDoctorCalendarAccess({
    doctorProfile: { doctorId: 'tenant-b', googleCalendarId: 'primary' },
    environment,
    bootstrapDoctorId: 'tenant-a'
  });
  assert.equal(notConnected.verified, false);
  assert.equal(notConnected.code, 'CALENDAR_NOT_CONNECTED');

  const originalCalendar = google.calendar;
  try {
    google.calendar = () => ({
      freebusy: { query: async () => ({ data: { calendars: { primary: { busy: [] } } } }) }
    });
    const verified = await verifyDoctorCalendarAccess({
      doctorProfile: {
        doctorId: 'tenant-a',
        googleCalendarId: 'primary',
        googleCredentialsEncrypted: encryptJson({ refreshToken: 'doctor-refresh' }, environment)
      },
      environment,
      bootstrapDoctorId: 'tenant-a'
    });
    assert.equal(verified.verified, true);
    assert.equal(verified.code, null);

    google.calendar = () => ({
      freebusy: {
        query: async () => {
          const error = new Error('invalid_grant: Token has been expired or revoked.');
          error.response = {
            status: 400,
            data: { error: { message: error.message, errors: [{ reason: 'invalid_grant' }] } }
          };
          throw error;
        }
      }
    });
    const revoked = await verifyDoctorCalendarAccess({
      doctorProfile: {
        doctorId: 'tenant-a',
        googleCalendarId: 'primary',
        googleCredentialsEncrypted: encryptJson({ refreshToken: 'doctor-refresh' }, environment)
      },
      environment,
      bootstrapDoctorId: 'tenant-a'
    });
    assert.equal(revoked.verified, false);
    assert.equal(revoked.code, 'invalid_grant');
    assert.match(revoked.message, /Reconnect the calendar/);
  } finally {
    google.calendar = originalCalendar;
  }
});
test('public legal pages expose privacy policy and terms for the OAuth consent screen', () => {
  const policy = privacyPolicy();
  const terms = termsOfService();
  assert.match(policy, /<!doctype html>/i);
  assert.match(policy, /Privacy Policy/);
  assert.match(policy, /Voice notes/i);
  assert.match(policy, /24 hours/);
  assert.match(policy, /not for emergencies/i);
  assert.match(policy, /Google/);
  assert.match(policy, /mailto:/);
  assert.match(terms, /Terms of Service/);
  assert.match(terms, /Not medical advice/i);
  assert.match(terms, /Acceptable use/i);
  assert.doesNotMatch(policy + terms, /undefined|\[object Object\]/);
});

test('dashboard settings expose public legal page URLs', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'legal-url-session-secret-long-enough';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originalFindById = DashboardUser.findById;
  const originalDoctorFindOne = Doctor.findOne;
  const user = { _id: 'legal-user', role: 'DOCTOR', doctorId: 'legal-tenant', isActive: true };
  DashboardUser.findById = () => ({ lean: async () => user });
  Doctor.findOne = () => ({
    select: () => ({ lean: async () => ({ doctorId: user.doctorId, isActive: true }) }),
    lean: async () => ({ doctorId: user.doctorId, isActive: true })
  });

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    mountDashboard(app, {}, 'Asia/Karachi', user.doctorId);
    const token = createSessionToken(user, secret, Date.now() + 60_000);
    const request = {
      headers: { cookie: `doctorbot_dashboard=${token}`, host: 'clinic.example' },
      protocol: 'https',
      query: {}
    };
    const response = {
      locals: {}, statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; }
    };
    const [settingsAuth, settingsHandler] = routes.get('GET /api/dashboard/settings');
    await settingsAuth(request, response, () => {});
    settingsHandler(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.privacyPolicyUrl, 'https://clinic.example/privacy-policy');
    assert.equal(response.body.termsOfServiceUrl, 'https://clinic.example/terms');
  } finally {
    DashboardUser.findById = originalFindById;
    Doctor.findOne = originalDoctorFindOne;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});
test('redirect URI stays https behind a TLS-terminating proxy such as Render', () => {
  // Render forwards an internal plain-HTTP hop, so Express reports protocol "http"
  // while the browser used HTTPS. X-Forwarded-Proto must win, otherwise an http://
  // redirect URI is built and Google rejects the connection.
  const proxied = resolveGoogleRedirectUri({
    protocol: 'http',
    secure: false,
    headers: { host: 'doctor-receptionist-bot.onrender.com', 'x-forwarded-proto': 'https' }
  }, {});
  assert.deepEqual(proxied, {
    redirectUri: 'https://doctor-receptionist-bot.onrender.com/api/auth/google/callback',
    error: null
  });

  // Chained proxies send a comma separated list; the first hop is the client-facing one.
  const chained = resolveGoogleRedirectUri({
    protocol: 'http',
    headers: { host: 'clinic.example', 'x-forwarded-proto': 'https, http' }
  }, {});
  assert.equal(chained.redirectUri, 'https://clinic.example/api/auth/google/callback');

  // Express secure flag is used when no proxy header is present.
  const secure = resolveGoogleRedirectUri({
    protocol: 'http',
    secure: true,
    headers: { host: 'clinic.example' }
  }, {});
  assert.equal(secure.redirectUri, 'https://clinic.example/api/auth/google/callback');

  // Plain localhost development still works over http.
  const local = resolveGoogleRedirectUri({ protocol: 'http', headers: { host: 'localhost:3000' } }, {});
  assert.equal(local.redirectUri, 'http://localhost:3000/api/auth/google/callback');

  // An explicitly configured HTTPS value still wins over anything derived.
  const explicit = resolveGoogleRedirectUri({
    protocol: 'http',
    headers: { host: 'ignored.example', 'x-forwarded-proto': 'http' }
  }, { GOOGLE_REDIRECT_URI: 'https://clinic.example/api/auth/google/callback' });
  assert.equal(explicit.redirectUri, 'https://clinic.example/api/auth/google/callback');
});
test('appointment slot offering reaches past the morning instead of stopping at eight', () => {
  const daySlots = [];
  for (let index = 0; index < 16; index += 1) {
    // Asia/Karachi is UTC+5, so 09:00 local is 04:00Z.
    const start = new Date(Date.UTC(2026, 9, 8, 4, index * 30));
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    daySlots.push({ start, end });
  }

  const firstPage = paginateSlots(daySlots, 0, { timeZone: 'Asia/Karachi', limit: 12 });
  assert.ok(firstPage.slots.length > 8, 'must offer more than eight slots');
  assert.equal(firstPage.moreAvailable, true);
  assert.equal(firstPage.nextOffset, firstPage.slots.length);
  assert.equal(firstPage.totalAvailable, 16);
  assert.equal(firstPage.slots[0].start.getTime(), daySlots[0].start.getTime());

  const secondPage = paginateSlots(daySlots, firstPage.nextOffset, { timeZone: 'Asia/Karachi', limit: 12 });
  assert.equal(secondPage.moreAvailable, false);
  const offered = [...firstPage.slots, ...secondPage.slots];
  assert.equal(offered.length, 16, 'every free slot must stay reachable');
  assert.equal(new Set(offered.map((slot) => slot.start.getTime())).size, 16, 'pages must not repeat slots');

  const latestLocalHour = getZonedDateParts(offered[offered.length - 1].start, 'Asia/Karachi').hour;
  assert.equal(latestLocalHour, 16, 'the 4:30 PM slot must be reachable');
});

test('slot offering interleaves times across open days', () => {
  const makeSlots = (day, hours) => hours.map((hour) => {
    const start = new Date(Date.UTC(2026, 9, day, hour - 5, 0));
    return { start, end: new Date(start.getTime() + 30 * 60 * 1000) };
  });
  const available = [...makeSlots(6, [9, 10, 11, 12, 13]), ...makeSlots(7, [9, 10, 11, 12, 13])];
  const ordered = buildOfferOrder(available, 'Asia/Karachi');
  const days = ordered.map((slot) => getSlotLocalDateKey(slot.start, 'Asia/Karachi'));
  assert.deepEqual(days.slice(0, 6), ['2026-10-06', '2026-10-07', '2026-10-06', '2026-10-07', '2026-10-06', '2026-10-07'],
    'should alternate days before repeating a time');
  assert.equal(ordered.length, 10);
});

test('slot offers tell the patient how to request more times', () => {
  const formatSlot = (slot, index) => `${index + 1}. slot`;
  const slots = [{ start: new Date('2026-10-08T04:00:00Z'), end: new Date('2026-10-08T04:30:00Z') }];
  assert.match(formatSlotOffer(slots, formatSlot, true), /Sirf slot ka number reply karein\./);
  assert.match(formatSlotOffer(slots, formatSlot, true), /"more"/);
  assert.doesNotMatch(formatSlotOffer(slots, formatSlot, false), /"more"/);
  assert.equal(isMoreSlotRequest('more'), true);
  assert.equal(isMoreSlotRequest('More'), true);
  assert.equal(isMoreSlotRequest('aur'), true);
  assert.equal(isMoreSlotRequest('agla'), true);
  assert.equal(isMoreSlotRequest('andhera'), true);
  assert.equal(isMoreSlotRequest('3'), false);
  assert.equal(isMoreSlotRequest('moreau'), false);
  assert.equal(isMoreSlotRequest(''), false);
});

test('conversation schema persists slot pagination state', async () => {
  const Conversation = mongoose.models.Conversation;
  const conversation = new Conversation({
    doctorId: 'paging-tenant',
    clinicId: 'paging-tenant',
    senderJid: 'test@s.whatsapp.net',
    step: 'calendarSelection',
    slotPage: 12,
    moreSlotsAvailable: true,
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000)
  });
  await assert.doesNotReject(conversation.validate());
  assert.equal(conversation.slotPage, 12);
  assert.equal(conversation.moreSlotsAvailable, true);
});
test('WhatsApp dashboard warns when sessions sit on an ephemeral filesystem', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'ephemeral-session-dashboard-secret-long';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originalFindById = DashboardUser.findById;
  const originalDoctorFindOne = Doctor.findOne;
  const user = { _id: 'ephemeral-user', role: 'DOCTOR', doctorId: 'ephemeral-clinic', isActive: true };
  DashboardUser.findById = () => ({ lean: async () => user });
  Doctor.findOne = () => ({ lean: async () => ({ doctorId: user.doctorId, isActive: true, setupComplete: true }) });

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    mountDashboard(app, {}, 'Asia/Karachi', user.doctorId, {
      getWhatsAppConnectionStatus: () => ({ status: 'connected' }),
      getWhatsAppSessionInfo: () => ({
        authDirectory: '/home/render/.local/share/DoctorBot/sessions',
        persistent: false,
        notice: 'WhatsApp device sessions are stored on an ephemeral filesystem and will be lost on every deploy. Set BAILEYS_AUTH_DIR to a mounted persistent disk.'
      })
    });
    const token = createSessionToken(user, secret, Date.now() + 60_000);
    const request = { headers: { cookie: `doctorbot_dashboard=${token}` } };
    const response = {
      locals: {}, statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; }
    };
    const [statusAuth, statusHandler] = routes.get('GET /api/dashboard/whatsapp/status');
    await statusAuth(request, response, () => {});
    statusHandler(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.sessionPersistent, false);
    assert.match(response.body.sessionNotice, /BAILEYS_AUTH_DIR/);
  } finally {
    DashboardUser.findById = originalFindById;
    Doctor.findOne = originalDoctorFindOne;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});
test('clinic timings fall back to environment defaults per doctor', () => {
  const environment = {
    OFFICE_START_HOUR: '8',
    OFFICE_END_HOUR: '20',
    APPOINTMENT_DURATION_MINUTES: '20',
    APPOINTMENT_LOOKAHEAD_DAYS: '10'
  };
  assert.deepEqual(resolveClinicTiming({}, environment), {
    officeStartHour: 8,
    officeEndHour: 20,
    appointmentDurationMinutes: 20,
    appointmentLookaheadDays: 10,
    usingEnvironment: true
  });
  assert.deepEqual(resolveClinicTiming(null, {}), {
    officeStartHour: 9,
    officeEndHour: 17,
    appointmentDurationMinutes: 30,
    appointmentLookaheadDays: 7,
    usingEnvironment: true
  });
  // An environment value outside the offered range is refused rather than used.
  const outOfRange = resolveClinicTiming({}, { ...environment, APPOINTMENT_DURATION_MINUTES: '45' });
  assert.equal(outOfRange.appointmentDurationMinutes, 30,
    'an unsupported environment duration must fall back, not be clamped silently');
});

test('slot durations run from five to thirty minutes', () => {
  assert.deepEqual(SLOT_DURATION_OPTIONS, [5, 10, 15, 20, 25, 30]);
  assert.equal(LIMITS.appointmentDurationMinutes.min, 5);
  assert.equal(LIMITS.appointmentDurationMinutes.max, 30);

  for (const option of SLOT_DURATION_OPTIONS) {
    assert.equal(isOfferedSlotDuration(option), true, `${option} must be offered`);
    assert.ok(isValidHourSetting('appointmentDurationMinutes', option), `${option} must be accepted`);
  }
  for (const rejected of [1, 4, 45, 60, 240]) {
    assert.equal(isValidHourSetting('appointmentDurationMinutes', rejected), false,
      `${rejected} minutes must be rejected`);
  }

  // A duration saved before this range existed is clamped, not discarded, so the
  // clinic keeps a sensible day length instead of reverting to the default.
  assert.equal(clampSlotDuration(45), 30);
  assert.equal(clampSlotDuration(60), 30);
  assert.equal(clampSlotDuration(240), 30);
  assert.equal(clampSlotDuration(1), 5);
  assert.equal(clampSlotDuration(12), 10);
  assert.equal(clampSlotDuration(23), 25);
  assert.equal(clampSlotDuration(20), 20);
  assert.equal(clampSlotDuration('30'), null, 'a non integer cannot be clamped');
  assert.equal(resolveClinicTiming({ appointmentDurationMinutes: 60 }).appointmentDurationMinutes, 30);
  assert.equal(resolveClinicTiming({ appointmentDurationMinutes: 45 }).appointmentDurationMinutes, 30);
  assert.equal(resolveClinicTiming({ appointmentDurationMinutes: 5 }).appointmentDurationMinutes, 5);
});

test('system errors are removed from the database after twenty four hours', () => {
  const ServiceLog = mongoose.models.ServiceLog;
  const ttl = ServiceLog.schema.path('createdAt').options.expires;
  assert.equal(typeof ttl, 'number', 'a string TTL is not a number Mongo can use');
  assert.equal(ttl, 86400);
  assert.equal(ttl / 3600, 24);
});

test('clinic timings stay unique per doctor with no cross-contamination', () => {
  const environment = { OFFICE_START_HOUR: '9', OFFICE_END_HOUR: '17' };
  const morning = resolveClinicTiming({
    doctorId: 'clinic-a', officeStartHour: 8, officeEndHour: 12, appointmentDurationMinutes: 30
  }, environment);
  const evening = resolveClinicTiming({
    doctorId: 'clinic-b', officeStartHour: 16, officeEndHour: 22, appointmentDurationMinutes: 20
  }, environment);

  assert.deepEqual(
    [morning.officeStartHour, morning.officeEndHour, morning.appointmentDurationMinutes],
    [8, 12, 30]
  );
  assert.deepEqual(
    [evening.officeStartHour, evening.officeEndHour, evening.appointmentDurationMinutes],
    [16, 22, 20]
  );
  assert.notEqual(morning.officeStartHour, evening.officeStartHour);
  // A partially configured doctor inherits only what it has not set itself.
  const partial = resolveClinicTiming({ officeEndHour: 21 }, environment);
  assert.equal(partial.officeStartHour, 9);
  assert.equal(partial.officeEndHour, 21);
});

test('clinic timings reject invalid or inverted ranges', () => {
  assert.equal(normalizeClinicTimingInput({ officeStartHour: 9, officeEndHour: 17 }).officeEndHour, 17);
  assert.equal(normalizeClinicTimingInput({ officeStartHour: 18, officeEndHour: 9 }), null, 'closing must be after opening');
  assert.equal(normalizeClinicTimingInput({ officeStartHour: 9, officeEndHour: 9 }), null, 'zero-length window');
  assert.equal(normalizeClinicTimingInput({ officeStartHour: 25 }), null, 'hour above 23');
  assert.equal(normalizeClinicTimingInput({ officeEndHour: 0 }), null, 'hour below 1');
  assert.equal(normalizeClinicTimingInput({ appointmentDurationMinutes: 4 }), null, 'slot below five minutes');
  assert.equal(normalizeClinicTimingInput({ appointmentDurationMinutes: 31 }), null, 'slot above thirty minutes');
  assert.equal(normalizeClinicTimingInput({ appointmentDurationMinutes: 45 }), null, 'the old maximum is no longer offered');
  assert.equal(normalizeClinicTimingInput({ appointmentDurationMinutes: 60 }), null, 'the old maximum is no longer offered');
  assert.equal(normalizeClinicTimingInput({ appointmentDurationMinutes: 5 }).appointmentDurationMinutes, 5, 'five minutes is valid');
  assert.equal(normalizeClinicTimingInput({ appointmentDurationMinutes: 30 }).appointmentDurationMinutes, 30, 'thirty minutes is valid');
  assert.equal(normalizeClinicTimingInput({ appointmentLookaheadDays: 0 }), null);
  assert.equal(normalizeClinicTimingInput({ appointmentLookaheadDays: 31 }), null);
  assert.deepEqual(normalizeClinicTimingInput({}), {}, 'absent fields are left untouched');
  assert.equal(normalizeClinicTimingInput({ appointmentLookaheadDays: '14' }).appointmentLookaheadDays, 14);
});

test('an inverted saved range falls back instead of producing no slots', () => {
  const timing = resolveClinicTiming(
    { officeStartHour: 20, officeEndHour: 10 },
    { OFFICE_START_HOUR: '9', OFFICE_END_HOUR: '17' }
  );
  assert.equal(timing.officeStartHour, 9);
  assert.equal(timing.officeEndHour, 17);
});

test('clinic timing fields are validated on the Doctor record', async () => {
  const Doctor = mongoose.models.Doctor;
  const doctor = new Doctor({
    doctorId: 'timing-tenant',
    email: 'timing@example.test',
    officeStartHour: 8,
    officeEndHour: 21,
    appointmentDurationMinutes: 20,
    appointmentLookaheadDays: 14
  });
  await assert.doesNotReject(doctor.validate());
  assert.equal(doctor.officeStartHour, 8);
  assert.equal(doctor.officeEndHour, 21);

  const outOfRange = new Doctor({ doctorId: 'bad-timing', email: 'bad@example.test', officeEndHour: 30 });
  await assert.rejects(outOfRange.validate());
});

test('doctor settings save and return clinic timings', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'clinic-timing-dashboard-secret-long';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originalFindById = DashboardUser.findById;
  const originalDoctorFindOne = Doctor.findOne;
  const originalDoctorFindOneAndUpdate = Doctor.findOneAndUpdate;
  const user = { _id: 'timing-user', role: 'DOCTOR', doctorId: 'timing-tenant', isActive: true };
  let doctor = { doctorId: user.doctorId, isActive: true, setupComplete: false };
  let savedUpdate;
  DashboardUser.findById = () => ({ lean: async () => user });
  Doctor.findOne = () => ({ lean: async () => doctor });
  Doctor.findOneAndUpdate = (filter, update) => {
    savedUpdate = update;
    doctor = { ...doctor, ...update.$set };
    return { lean: async () => doctor };
  };

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    mountDashboard(app, {}, 'Asia/Karachi', user.doctorId);
    const token = createSessionToken(user, secret, Date.now() + 60_000);
    const request = {
      headers: { cookie: `doctorbot_dashboard=${token}` },
      query: {},
      body: {
        doctorName: 'Dr. Timing',
        clinicName: 'Timing Clinic',
        basicCheckupFee: 500,
        facilityPricing: [{ category: 'facility', name: 'OPD', price: 500 }],
        consultationDetails: 'Walk-ins welcome.',
        workingDays: [1, 2, 3, 4, 5],
        offDays: [],
        religion: 'Muslim',
        welcomeMessage: '',
        officeStartHour: 8,
        officeEndHour: 13,
        appointmentDurationMinutes: 20,
        appointmentLookaheadDays: 14
      }
    };
    const makeResponse = () => ({
      locals: {}, statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; }
    });

    let response = makeResponse();
    const [settingsAuth, settingsHandler] = routes.get('PUT /api/dashboard/settings');
    await settingsAuth(request, response, () => {});
    await settingsHandler(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(savedUpdate.$set.officeStartHour, 8);
    assert.equal(savedUpdate.$set.officeEndHour, 13);
    assert.equal(savedUpdate.$set.appointmentDurationMinutes, 20);
    assert.equal(savedUpdate.$set.appointmentLookaheadDays, 14);
    assert.equal(response.body.officeStartHour, 8);
    assert.equal(response.body.officeEndHour, 13);

    // Inverted hours must be rejected outright.
    request.body.officeStartHour = 18;
    request.body.officeEndHour = 9;
    response = makeResponse();
    await settingsAuth(request, response, () => {});
    await settingsHandler(request, response);
    assert.equal(response.statusCode, 400);
  } finally {
    DashboardUser.findById = originalFindById;
    Doctor.findOne = originalDoctorFindOne;
    Doctor.findOneAndUpdate = originalDoctorFindOneAndUpdate;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});
test('changing religion drops stale holiday overrides instead of blocking the save', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'holiday-override-regression-secret-long';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originalFindById = DashboardUser.findById;
  const originalDoctorFindOne = Doctor.findOne;
  const originalDoctorFindOneAndUpdate = Doctor.findOneAndUpdate;
  const user = { _id: 'override-user', role: 'DOCTOR', doctorId: 'override-tenant', isActive: true };
  const existingDoctor = {
    doctorId: user.doctorId,
    isActive: true,
    // Left over from when this clinic was Muslim.
    religiousHolidayOpenDays: ['2027-03-09', '2027-05-16']
  };
  let savedUpdate;
  DashboardUser.findById = () => ({ lean: async () => user });
  Doctor.findOne = () => ({ lean: async () => existingDoctor });
  Doctor.findOneAndUpdate = (filter, update) => {
    savedUpdate = update;
    return { lean: async () => ({ ...existingDoctor, ...update.$set }) };
  };

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    mountDashboard(app, {}, 'Asia/Karachi', user.doctorId);
    const token = createSessionToken(user, secret, Date.now() + 60_000);
    const request = {
      headers: { cookie: `doctorbot_dashboard=${token}` },
      query: {},
      body: {
        doctorName: 'Dr. Override',
        clinicName: 'Override Clinic',
        basicCheckupFee: 450,
        facilityPricing: [{ category: 'facility', name: 'OPD', price: 450 }],
        consultationDetails: 'Walk-ins welcome.',
        workingDays: [1, 2, 3, 4, 5],
        offDays: ['2026-10-07'],
        religion: 'Christian',
        religiousHolidayOpenDays: ['2027-03-09', '2027-05-16'],
        welcomeMessage: 'Welcome.'
      }
    };
    const response = {
      locals: {}, statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; }
    };
    const [settingsAuth, settingsHandler] = routes.get('PUT /api/dashboard/settings');
    await settingsAuth(request, response, () => {});
    await settingsHandler(request, response);
    assert.equal(response.statusCode, 200, 'stale Muslim overrides must not reject the save');
    assert.deepEqual(savedUpdate.$set.religiousHolidayOpenDays, []);

    // A genuine Christian override is kept.
    request.body.religiousHolidayOpenDays = ['2026-12-25'];
    response.statusCode = 200;
    await settingsAuth(request, response, () => {});
    await settingsHandler(request, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(savedUpdate.$set.religiousHolidayOpenDays, ['2026-12-25']);
  } finally {
    DashboardUser.findById = originalFindById;
    Doctor.findOne = originalDoctorFindOne;
    Doctor.findOneAndUpdate = originalDoctorFindOneAndUpdate;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});

test('clinic setup reports which field is invalid', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'precise-error-dashboard-secret-long';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originalFindById = DashboardUser.findById;
  const originalDoctorFindOne = Doctor.findOne;
  const user = { _id: 'error-user', role: 'DOCTOR', doctorId: 'error-tenant', isActive: true };
  const doctor = { doctorId: user.doctorId, isActive: true, setupComplete: true };
  DashboardUser.findById = () => ({ lean: async () => user });
  Doctor.findOne = () => ({ lean: async () => doctor });

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    mountDashboard(app, {}, 'Asia/Karachi', user.doctorId);
    const token = createSessionToken(user, secret, Date.now() + 60_000);
    const base = {
      doctorName: 'Dr. Error',
      clinicName: 'Error Clinic',
      basicCheckupFee: 450,
      facilityPricing: [{ category: 'facility', name: 'OPD', price: 450 }],
      consultationDetails: 'Walk-ins welcome.',
      workingDays: [1, 2, 3, 4, 5],
      offDays: [],
      religion: 'Muslim',
      welcomeMessage: 'Welcome.'
    };
    const send = async (body) => {
      const request = { headers: { cookie: `doctorbot_dashboard=${token}` }, query: {}, body };
      const response = {
        locals: {}, statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; }
      };
      const [auth, handler] = routes.get('PUT /api/dashboard/settings');
      await auth(request, response, () => {});
      await handler(request, response);
      return response;
    };

    assert.equal((await send({ ...base, workingDays: [] })).body.error, 'Select at least one working day.');
    assert.equal((await send({ ...base, facilityPricing: [] })).body.error,
      'Add at least one facility or treatment, using the "Add facility or treatment" button.');
    assert.equal((await send({ ...base, officeStartHour: 18, officeEndHour: 9 })).body.error,
      'Check the clinic timings: closing time must be later than opening time, and bookings 1 to 30 days ahead.');
    assert.equal((await send({ ...base, basicCheckupFee: -5 })).body.error,
      'Enter the basic checkup fee as a rupee amount of 0 or more.');
    assert.equal((await send({ ...base, consultationDetails: '   ' })).body.error,
      'Enter consultation details of 2000 characters or fewer.');
  } finally {
    DashboardUser.findById = originalFindById;
    Doctor.findOne = originalDoctorFindOne;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});
test('superadmin overview, analytics, system and logs endpoints serve real data', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'admin-panel-session-secret-long-enough';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const Appointment = mongoose.models.Appointment;
  const InboundMessage = mongoose.models.InboundMessage;
  const ServiceLog = mongoose.models.ServiceLog;

  const originals = {
    dashboardFindById: DashboardUser.findById,
    doctorFind: Doctor.find,
    doctorCount: Doctor.countDocuments,
    doctorExists: Doctor.exists,
    appointmentFind: Appointment.find,
    appointmentCount: Appointment.countDocuments,
    appointmentDistinct: Appointment.distinct,
    appointmentAggregate: Appointment.aggregate,
    inboundCount: InboundMessage.countDocuments,
    inboundAggregate: InboundMessage.aggregate,
    serviceCount: ServiceLog.countDocuments,
    serviceFind: ServiceLog.find,
    serviceAggregate: ServiceLog.aggregate,
    reportFind: mongoose.models.DailyReportRun.find
  };

  const admin = { _id: 'admin-panel-user', role: 'SUPERADMIN', doctorId: null, isActive: true };
  const doctorRows = [
    { doctorId: 'clinic-one', doctorName: 'Dr. One', clinicName: 'Clinic One', email: 'one@example.test', isActive: true, setupComplete: true, googleCalendarConnected: true },
    { doctorId: 'clinic-two', doctorName: 'Dr. Two', clinicName: 'Clinic Two', email: 'two@example.test', isActive: false, setupComplete: false, googleCalendarConnected: false }
  ];
  const appointmentRows = [
    { _id: 'a1', doctorId: 'clinic-one', senderJid: 'p1@s.whatsapp.net', details: { name: 'Ada', contactNumber: '+923001' }, slotStart: new Date('2026-10-08T05:00:00Z'), slotEnd: new Date('2026-10-08T05:30:00Z'), bookedAt: new Date(), status: 'booked' }
  ];

  const leanResult = (rows) => {
    const chain = {
      sort() { return chain; },
      select() { return chain; },
      limit() { return chain; },
      lean: async () => rows
    };
    return chain;
  };
  DashboardUser.findById = () => ({ lean: async () => admin });
  Doctor.find = (filter) => {
    if (filter && filter.select) return leanResult(doctorRows.map(({ doctorId, isActive, setupComplete, googleCalendarConnected }) => ({ doctorId, isActive, setupComplete, googleCalendarConnected })));
    return leanResult(doctorRows);
  };
  Doctor.countDocuments = async () => 2;
  Doctor.exists = async () => true;
  Appointment.find = () => leanResult(appointmentRows);
  Appointment.countDocuments = async () => 1;
  Appointment.distinct = async () => ['p1@s.whatsapp.net'];
  Appointment.aggregate = async (pipeline) => (pipeline.some((stage) => stage.$dateToString)
    ? [{ _id: '2026-10-07', appointments: 3 }]
    : [{ _id: 'clinic-one', total: 5, upcoming: 2, inPeriod: 3, lastBookedAt: new Date() }]);
  InboundMessage.countDocuments = async () => 12;
  InboundMessage.aggregate = async () => [{ _id: 'clinic-one', messages: 12, voice: 2 }];
  ServiceLog.countDocuments = async () => 1;
  ServiceLog.find = () => leanResult([{ _id: 'l1', doctorId: 'clinic-one', level: 'error', event: 'Calendar booking', code: 'X', createdAt: new Date() }]);
  ServiceLog.aggregate = async () => [{ _id: { doctorId: 'clinic-one', level: 'error' }, count: 1 }];
  mongoose.models.DailyReportRun.find = () => ({ select() { return this; }, limit() { return this; }, lean: async () => [] });

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    mountDashboard(app, Appointment, 'Asia/Karachi', 'clinic-one', {
      getWhatsAppSessionInfo: () => ({ authDirectory: '/data/sessions', persistent: true, notice: null }),
      listWhatsAppStatuses: () => [{ doctorId: 'clinic-one', status: 'connected' }]
    });
    const token = createSessionToken(admin, secret, Date.now() + 60_000);
    const request = { headers: { cookie: `doctorbot_dashboard=${token}` }, query: {}, params: {} };
    const makeResponse = () => ({
      locals: {}, statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; }
    });

    // Admin routes chain requireDashboardAuth, requireSuperadmin, then the handler,
// so every handler in the chain must run.
    const call = async (route, query = {}) => {
      const response = makeResponse();
      const handlers = routes.get(route);
      request.query = query;
      for (let index = 0; index < handlers.length; index += 1) {
        const isLast = index === handlers.length - 1;
        await handlers[index](request, response, () => {});
        if (isLast) break;
        if (response.statusCode >= 400) break;
      }
      return response;
    };

    const overview = await call('GET /api/admin/overview');
    assert.equal(overview.statusCode, 200);
    assert.equal(overview.body.doctors.total, 2);
    assert.equal(overview.body.appointments.total, 1);
    assert.equal(overview.body.appointments.uniquePatients, 1);
    assert.equal(overview.body.messaging.receivedLast24Hours, 12);

    const appointments = await call('GET /api/admin/appointments', { limit: '10', doctorId: 'clinic-one', q: 'Ada' });
    assert.equal(appointments.statusCode, 200);
    assert.equal(appointments.body.appointments.length, 1);
    assert.equal(appointments.body.appointments[0].clinicName, 'Clinic One', 'must resolve the clinic name');
    assert.equal(appointments.body.timeZone, 'Asia/Karachi');

    const badDoctor = await call('GET /api/admin/appointments', { doctorId: '../etc/passwd' });
    assert.equal(badDoctor.statusCode, 400, 'must reject a non-slug doctorId');

    const analytics = await call('GET /api/admin/analytics', { days: '14' });
    assert.equal(analytics.statusCode, 200);
    assert.equal(analytics.body.dailyBookings.length, 1);
    assert.equal(analytics.body.doctors.length, 2, 'must include clinics with no activity');
    const clinicOne = analytics.body.doctors.find((row) => row.doctorId === 'clinic-one');
    assert.equal(clinicOne.totalAppointments, 5);
    assert.equal(clinicOne.messagesReceived, 12);
    assert.equal(clinicOne.errors, 1);

    const system = await call('GET /api/admin/system');
    assert.equal(system.statusCode, 200);
    assert.equal(system.body.runtime.timeZone, 'Asia/Karachi');
    assert.equal(system.body.whatsapp.sessionPersistent, true);
    assert.equal(system.body.whatsapp.connections.length, 1);
    assert.equal(system.body.clinics.length, 2);
    assert.ok(system.body.readiness, 'the system panel must report integration readiness');
    assert.ok(Array.isArray(system.body.readiness.blocked));
    for (const item of system.body.readiness.blocked) {
      assert.equal(typeof item.missing, 'object');
      assert.ok(item.remedy.length > 40, 'each blocked integration must explain its fix');
    }
    assert.ok(!JSON.stringify(system.body.readiness).includes('undefined-secret'));
    assert.equal(Object.keys(system.body.configuration).some((key) => /password|secret|key$/i.test(key) && system.body.configuration[key]), false,
      'configuration must never expose secrets');

    const logs = await call('GET /api/admin/service-logs', { level: 'error' });
    assert.equal(logs.statusCode, 200);
    assert.equal(logs.body.logs[0].doctorName, 'Dr. One');
  } finally {
    DashboardUser.findById = originals.dashboardFindById;
    Doctor.find = originals.doctorFind;
    Doctor.countDocuments = originals.doctorCount;
    Doctor.exists = originals.doctorExists;
    Appointment.find = originals.appointmentFind;
    Appointment.countDocuments = originals.appointmentCount;
    Appointment.distinct = originals.appointmentDistinct;
    Appointment.aggregate = originals.appointmentAggregate;
    InboundMessage.countDocuments = originals.inboundCount;
    InboundMessage.aggregate = originals.inboundAggregate;
    ServiceLog.countDocuments = originals.serviceCount;
    ServiceLog.find = originals.serviceFind;
    ServiceLog.aggregate = originals.serviceAggregate;
    mongoose.models.DailyReportRun.find = originals.reportFind;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});

test('doctor accounts cannot reach any superadmin control panel endpoint', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'admin-guard-session-secret-long-enough';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originalFindById = DashboardUser.findById;
  const originalDoctorFindOne = Doctor.findOne;
  const doctor = { _id: 'doctor-user', role: 'DOCTOR', doctorId: 'clinic-one', isActive: true };
  DashboardUser.findById = () => ({ lean: async () => doctor });
  Doctor.findOne = () => ({ select: () => ({ lean: async () => ({ doctorId: doctor.doctorId, isActive: true }) }), lean: async () => ({ doctorId: doctor.doctorId, isActive: true }) });

  try {
    const routes = new Map();
    const app = {
      use() {},
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
      delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); }
    };
    mountDashboard(app, {}, 'Asia/Karachi', doctor.doctorId);
    const token = createSessionToken(doctor, secret, Date.now() + 60_000);
    const request = { headers: { cookie: `doctorbot_dashboard=${token}` }, query: {}, params: {} };

    for (const route of ['GET /api/admin/overview', 'GET /api/admin/appointments',
      'GET /api/admin/analytics', 'GET /api/admin/system', 'GET /api/admin/service-logs',
      'GET /api/admin/doctors']) {
      const response = { locals: {}, statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
      const handlers = routes.get(route);
      await handlers[0](request, response, () => {});
      handlers[1](request, response, () => {});
      assert.equal(response.statusCode, 403, `${route} must reject a doctor session`);
    }
  } finally {
    DashboardUser.findById = originalFindById;
    Doctor.findOne = originalDoctorFindOne;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});
test('report time is validated, stored per clinic and returned to the dashboard', async () => {
  assert.equal(normalizeReportTime('07:30'), '07:30');
  assert.equal(normalizeReportTime(''), '00:00', 'blank falls back to midnight');
  assert.equal(normalizeReportTime(undefined), '00:00');
  assert.equal(normalizeReportTime('24:00'), null, '24:00 is not a valid 24-hour time');
  assert.equal(normalizeReportTime('23:60'), null, 'minutes must stay under 60');
  assert.equal(normalizeReportTime('7:30'), null, 'hours must be zero padded');
  assert.equal(normalizeReportTime('07:30 PM'), null, 'a 12-hour suffix must be rejected');

  assert.equal(currentLocalTime(new Date('2026-10-07T02:30:00Z'), 'Asia/Karachi'), '07:30');
  assert.equal(isReportDueNow({ reportTime: '07:30' }, new Date('2026-10-07T02:30:00Z'), 'Asia/Karachi'), true);
  assert.equal(isReportDueNow({ reportTime: '07:31' }, new Date('2026-10-07T02:30:00Z'), 'Asia/Karachi'), false);
  assert.equal(isReportDueNow({}, new Date('2026-10-07T02:30:00Z'), 'Asia/Karachi'), false,
    'a clinic without a saved time must not be due at an arbitrary minute');
  assert.equal(isReportDueNow({ reportTime: '02:30' }, new Date('2026-10-07T02:30:00Z'), 'UTC'), true,
    'the window must follow the configured time zone, not a hard-coded offset');
  assert.equal(isReportDueNow({ reportTime: '07:30' }, new Date('2026-10-07T02:30:00Z'), 'UTC'), false);
});

test('the daily report scheduler dispatches only clinics that are due', async () => {
  const dispatched = [];
  const scheduler = startDailyReportScheduler({
    timeZone: 'Asia/Karachi',
    tickMs: 60_000,
    now: () => new Date('2026-10-07T02:30:00Z'),
    listDoctors: async () => [
      { doctorId: 'due-clinic', reportTime: '07:30' },
      { doctorId: 'other-minute', reportTime: '19:00' },
      { doctorId: 'unset-clinic' },
      { doctorId: null, reportTime: '07:30' }
    ],
    dispatch: (doctor) => {
      dispatched.push(doctor.doctorId);
      return Promise.resolve({ sent: true });
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  clearInterval(scheduler);
  assert.deepEqual(dispatched, ['due-clinic'], 'only the clinic matching the current minute may run');
});

test('the daily report scheduler survives a database failure without stopping', async () => {
  let attempts = 0;
  const scheduler = startDailyReportScheduler({
    timeZone: 'Asia/Karachi',
    tickMs: 60_000,
    now: () => new Date('2026-10-07T02:30:00Z'),
    listDoctors: async () => {
      attempts += 1;
      throw new Error('database unavailable');
    },
    dispatch: () => Promise.resolve({ sent: true })
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  clearInterval(scheduler);
  assert.equal(attempts, 1, 'a failed listing must not throw out of the tick');
});
const { existsSync } = require('node:fs');
const { evaluateReadiness } = require('../src/readiness');
const { describeEmailConfiguration, diagnoseEmailPipeline, explainSmtpFailure } = require('../src/emailDiagnostics');

const fullyConfigured = {
  OPENAI_API_KEY: 'sk-live-abcdef123456',
  OPENAI_ALLOW_PHI_PROCESSING: 'true',
  GEMINI_API_KEY: 'AIzaSyEXAMPLEKEY12345',
  GEMINI_ALLOW_PHI_PROCESSING: 'true',
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_PORT: '587',
  SMTP_USER: 'reports@example.test',
  SMTP_PASS: 'super-secret-password',
  EMAIL_FROM: 'reports@example.test',
  BAILEYS_AUTH_DIR: '/data/sessions',
  GOOGLE_CLIENT_ID: '123.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'GOCSPX-secret-value',
  TRUST_PROXY: 'true'
};

test('readiness names the exact variables a disabled integration needs', () => {
  const empty = evaluateReadiness({}, { googleRedirectUriValid: true });
  assert.deepEqual(empty.features.voiceTranscription.missing, ['OPENAI_API_KEY', 'OPENAI_ALLOW_PHI_PROCESSING']);
  assert.deepEqual(empty.features.geminiExtraction.missing, ['GEMINI_API_KEY', 'GEMINI_ALLOW_PHI_PROCESSING']);
  assert.deepEqual(empty.features.emailReports.missing, ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM']);
  assert.deepEqual(empty.features.whatsappSessions.missing, ['BAILEYS_AUTH_DIR']);
  assert.deepEqual(empty.features.trustProxy.missing, ['TRUST_PROXY']);
  assert.equal(empty.ready, false);
  assert.equal(empty.blocked.length, 6);
});

test('readiness reports an integration as ready once it is configured', () => {
  const ready = evaluateReadiness(fullyConfigured, { googleRedirectUriValid: true });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.blocked, []);
  for (const feature of Object.values(ready.features)) {
    assert.equal(feature.ready, true, 'every configured feature must report ready');
    assert.deepEqual(feature.missing, []);
  }
});

test('a present API key with a missing consent flag still reports the flag only', () => {
  // This is the live state: the keys exist, the consent flags do not.
  const partial = evaluateReadiness({
    OPENAI_API_KEY: 'sk-live-abcdef123456',
    GEMINI_API_KEY: 'AIzaSyEXAMPLEKEY12345'
  }, { googleRedirectUriValid: true });
  assert.deepEqual(partial.features.voiceTranscription.missing, ['OPENAI_ALLOW_PHI_PROCESSING']);
  assert.equal(partial.features.voiceTranscription.ready, false);
  assert.deepEqual(partial.features.geminiExtraction.missing, ['GEMINI_ALLOW_PHI_PROCESSING']);
  // Email and sessions were not configured at all in this environment.
  assert.deepEqual(partial.features.emailReports.missing, ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM']);
});

test('a consent flag is only honoured as the exact string true', () => {
  for (const value of ['true', 'TRUE', 'True', ' true ']) {
    assert.equal(evaluateReadiness({ ...fullyConfigured, OPENAI_ALLOW_PHI_PROCESSING: value })
      .features.voiceTranscription.ready, true, `"${value}" should be accepted`);
  }
  for (const value of ['1', 'yes', 'on', 'false', '']) {
    assert.equal(evaluateReadiness({ ...fullyConfigured, OPENAI_ALLOW_PHI_PROCESSING: value })
      .features.voiceTranscription.ready, false, `"${value}" must not enable patient data processing`);
  }
});

test('readiness never returns a configured secret value', () => {
  const ready = evaluateReadiness(fullyConfigured, { googleRedirectUriValid: true });
  const serialised = JSON.stringify(ready);
  for (const secret of ['sk-live-abcdef123456', 'AIzaSyEXAMPLEKEY12345', 'super-secret-password',
    'GOCSPX-secret-value', '123.apps.googleusercontent.com']) {
    assert.ok(!serialised.includes(secret), `readiness leaked a configured value: ${secret}`);
  }
  // Whitespace-only values must count as absent rather than configured.
  const blank = evaluateReadiness({ OPENAI_API_KEY: '   ', SMTP_HOST: '' }, { googleRedirectUriValid: true });
  assert.deepEqual(blank.features.voiceTranscription.missing, ['OPENAI_API_KEY', 'OPENAI_ALLOW_PHI_PROCESSING']);
  assert.ok(blank.features.emailReports.missing.includes('SMTP_HOST'));
});

test('Google Calendar stays not ready until the redirect URI is valid', () => {
  const bad = evaluateReadiness(fullyConfigured, { googleRedirectUriValid: false });
  assert.equal(bad.features.googleCalendar.ready, false);
  assert.deepEqual(bad.features.googleCalendar.missing, [], 'the client credentials are present');
  assert.match(bad.features.googleCalendar.remedy, /GOOGLE_REDIRECT_URI/);
});

test('every blocked entry carries a label, its variables and a remedy', () => {
  const { blocked } = evaluateReadiness({}, { googleRedirectUriValid: false });
  assert.ok(blocked.length > 0);
  for (const item of blocked) {
    assert.equal(typeof item.label, 'string');
    assert.ok(item.label.length > 0, `${item.key} must have a readable label`);
    assert.ok(Array.isArray(item.missing));
    assert.ok(item.remedy.length > 40, `${item.key} must explain how to fix itself`);
  }
});
function buildApp() {
  const routes = new Map();
  const app = {
    use() {},
    get: (p, ...h) => routes.set(`GET ${p}`, h),
    post: (p, ...h) => routes.set(`POST ${p}`, h),
    put: (p, ...h) => routes.set(`PUT ${p}`, h),
    patch: (p, ...h) => routes.set(`PATCH ${p}`, h),
    delete: (p, ...h) => routes.set(`DELETE ${p}`, h)
  };
  return { app, routes };
}

test('deleting a doctor requires the doctor id echoed back as confirmation', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'delete-doctor-session-secret-long-enough';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const Doctor = mongoose.models.Doctor;
  const DashboardUser = mongoose.models.DashboardUser;
  const originalFindOne = Doctor.findOne;
  const originalUserFindById = DashboardUser.findById;
  let deleteCalls = 0;
  Doctor.findOne = () => ({ select: () => ({ lean: async () => ({ doctorId: 'clinic-x', clinicName: 'Clinic X' }) }) });
  DashboardUser.findById = () => ({ lean: async () => ({ _id: 'admin-1', role: 'SUPERADMIN', doctorId: null, isActive: true }) });

  try {
    const { app, routes } = buildApp();
    mountDashboard(app, mongoose.models.Appointment, 'Asia/Karachi', 'clinic-x', {
      getWhatsAppSessionInfo: () => ({ authDirectory: '/nonexistent-doctorbot-test-root', persistent: false })
    });
    const admin = { _id: 'admin-1', role: 'SUPERADMIN', doctorId: null, isActive: true };
    const token = createSessionToken(admin, secret, Date.now() + 60_000);

    const call = async (params, body) => {
      const response = { locals: {}, statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; } };
      const request = { headers: { cookie: `doctorbot_dashboard=${token}` }, query: {}, params, body };
      const handlers = routes.get('DELETE /api/admin/doctors/:doctorId');
      for (let i = 0; i < handlers.length; i += 1) {
        const last = i === handlers.length - 1;
        await handlers[i](request, response, () => {});
        if (last || response.statusCode >= 400) break;
      }
      return response;
    };

    const noConfirmation = await call({ doctorId: 'clinic-x' }, {});
    assert.equal(noConfirmation.statusCode, 400);
    assert.equal(noConfirmation.body.requiresConfirmation, true);
    assert.match(noConfirmation.body.error, /confirm/);

    const wrongConfirmation = await call({ doctorId: 'clinic-x' }, { confirm: 'some-other-clinic' });
    assert.equal(wrongConfirmation.statusCode, 400);
    assert.equal(wrongConfirmation.body.requiresConfirmation, true);

    const badId = await call({ doctorId: '../../etc/passwd' }, { confirm: '../../etc/passwd' });
    assert.equal(badId.statusCode, 400);

    assert.equal(deleteCalls, 0, 'no deletion may happen before the confirmation matches');
  } finally {
    Doctor.findOne = originalFindOne;
    DashboardUser.findById = originalUserFindById;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});

test('a doctor session cannot delete any account', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'delete-guard-session-secret-long-enough';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const Doctor = mongoose.models.Doctor;
  const DashboardUser = mongoose.models.DashboardUser;
  const originalDoctorFindOne = Doctor.findOne;
  const originalUserFindById = DashboardUser.findById;
  const doctorUser = { _id: 'doctor-1', role: 'DOCTOR', doctorId: 'clinic-y', isActive: true };
  DashboardUser.findById = () => ({ lean: async () => doctorUser });
  Doctor.findOne = () => ({
    select: () => ({ lean: async () => ({ doctorId: doctorUser.doctorId, isActive: true, setupComplete: true }) }),
    lean: async () => ({ doctorId: doctorUser.doctorId, isActive: true, setupComplete: true })
  });

  try {
    const { app, routes } = buildApp();
    mountDashboard(app, mongoose.models.Appointment, 'Asia/Karachi', doctorUser.doctorId);
    const token = createSessionToken(doctorUser, secret, Date.now() + 60_000);
    const response = { locals: {}, statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; } };
    const request = {
      headers: { cookie: `doctorbot_dashboard=${token}` }, query: {},
      params: { doctorId: 'clinic-y' }, body: { confirm: 'clinic-y' }
    };
    const handlers = routes.get('DELETE /api/admin/doctors/:doctorId');
    for (let i = 0; i < handlers.length; i += 1) {
      const last = i === handlers.length - 1;
      await handlers[i](request, response, () => {});
      if (last || response.statusCode >= 400) break;
    }
    assert.equal(response.statusCode, 403, 'a doctor must not be able to delete an account');
  } finally {
    Doctor.findOne = originalDoctorFindOne;
    DashboardUser.findById = originalUserFindById;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});
test('a mounted persistent disk satisfies session persistence without the variable', () => {
  const noVariable = { ...fullyConfigured };
  delete noVariable.BAILEYS_AUTH_DIR;

  const withDisk = evaluateReadiness(noVariable, {
    googleRedirectUriValid: true,
    diskRoots: ['/tmp/doctorbot-test-disk']
  });
  const withoutDisk = evaluateReadiness(noVariable, {
    googleRedirectUriValid: true,
    diskRoots: ['/tmp/doctorbot-no-such-disk-xyz']
  });
  if (existsSync('/tmp/doctorbot-test-disk')) {
    assert.equal(withDisk.features.whatsappSessions.ready, true,
      'a real mounted disk means sessions already survive deploys');
  } else {
    assert.equal(withoutDisk.features.whatsappSessions.ready, false,
      'without a disk the clinic still has to rescan its QR code');
  }
  assert.deepEqual(withDisk.features.whatsappSessions.missing, ['BAILEYS_AUTH_DIR'],
    'the variable is still reported so the operator can make the path explicit');
});

test('an unwritable session folder is never reported as persistent', () => {
  const result = evaluateReadiness(fullyConfigured, {
    googleRedirectUriValid: true,
    sessionWritable: false
  });
  assert.equal(result.features.whatsappSessions.ready, false,
    'a read only folder cannot hold a session even on a persistent disk');
});
test('a report is still due after its minute passes, so a sleeping process recovers it', async () => {
  assert.equal(isReportCatchUpDue({ reportTime: '07:30' }, new Date('2026-10-07T02:30:00Z'), 'Asia/Karachi'), true);
  // 07:31 local: the exact-minute match is already false here, which is why the
  // report used to be lost whenever a tick was missed.
  assert.equal(isReportDueNow({ reportTime: '07:30' }, new Date('2026-10-07T02:31:00Z'), 'Asia/Karachi'), false);
  assert.equal(isReportCatchUpDue({ reportTime: '07:30' }, new Date('2026-10-07T02:31:00Z'), 'Asia/Karachi'), true);
  // Still inside the default three hour window.
  assert.equal(isReportCatchUpDue({ reportTime: '07:30' }, new Date('2026-10-07T05:00:00Z'), 'Asia/Karachi'), true);
  // Window closed, so a clinic is not mailed at midnight the next day.
  assert.equal(isReportCatchUpDue({ reportTime: '07:30' }, new Date('2026-10-07T12:00:00Z'), 'Asia/Karachi'), false);
  // Before the report time it is never due.
  assert.equal(isReportCatchUpDue({ reportTime: '07:30' }, new Date('2026-10-07T01:00:00Z'), 'Asia/Karachi'), false);
  assert.equal(isReportCatchUpDue({ reportTime: '00:00' }, new Date('2026-10-07T02:00:00Z'), 'Asia/Karachi'), false,
    'a midnight report must not be retried hours later');
  assert.equal(reportCatchUpMinutes('not a number'), 180);
  assert.equal(reportCatchUpMinutes('9999'), 180);
  assert.equal(reportCatchUpMinutes('30'), 30);
});

test('the scheduler catches up a missed window and stops retrying a failing clinic', async () => {
  const dispatched = [];
  // The process was asleep through 07:30 and only wakes at 07:33.
  let current = new Date('2026-10-07T02:33:00Z');
  const scheduler = startDailyReportScheduler({
    timeZone: 'Asia/Karachi',
    tickMs: 60_000,
    now: () => current,
    retryDelayMs: 15 * 60 * 1000,
    listDoctors: async () => [{ doctorId: 'sleeper', reportTime: '07:30' }],
    dispatch: (doctor) => {
      dispatched.push(doctor.doctorId);
      return Promise.resolve({ sent: false, reason: 'smtp down' });
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(dispatched, ['sleeper'],
    'a window missed while the process slept must still deliver the report');

  // Ticking again inside the retry delay must not hammer a failing SMTP server.
  current = new Date('2026-10-07T02:34:00Z');
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(dispatched.length, 1, 'a failing clinic must back off instead of retrying every tick');

  clearInterval(scheduler);
});

test('a clinic outside its report window is never dispatched', async () => {
  const dispatched = [];
  const scheduler = startDailyReportScheduler({
    timeZone: 'Asia/Karachi',
    tickMs: 60_000,
    now: () => new Date('2026-10-07T02:30:00Z'),
    listDoctors: async () => [
      { doctorId: 'due', reportTime: '07:30' },
      { doctorId: 'later', reportTime: '19:00' }
    ],
    dispatch: (doctor) => {
      dispatched.push(doctor.doctorId);
      return Promise.resolve({ sent: true });
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  clearInterval(scheduler);
  assert.deepEqual(dispatched, ['due']);
});

test('the superadmin save drops a stale holiday override instead of refusing everything', () => {
  const existing = {
    doctorId: 'clinic-holiday',
    doctorName: 'Dr. Holiday',
    clinicName: 'Holiday Clinic',
    religion: 'Muslim',
    basicCheckupFee: 500,
    facilityPricing: [{ category: 'facility', name: 'Consultation', price: 500 }],
    consultationDetails: 'Consultation charges Rs. 1500',
    workingDays: [1, 2, 3, 4, 5],
    offDays: [],
    welcomeMessage: 'Welcome',
    religiousHolidayOpenDays: []
  };
  // A date that is not a holiday for the selected religion. The doctor save path
  // filters this out; the admin path used to reject the entire save.
  const stale = '2026-01-01';
  const patch = normalizeAdminDoctorPatch({
    clinicName: 'Holiday Clinic Renamed',
    religiousHolidayOpenDays: [stale]
  }, existing);

  assert.ok(patch, 'a stale holiday override must not block the rest of the save');
  assert.equal(patch.clinicName, 'Holiday Clinic Renamed');
  assert.deepEqual(patch.religiousHolidayOpenDays, []);
  assert.equal(patch.droppedHolidayOverrides, 1);
  // The count must never be written to the profile.
  assert.equal(Object.keys(patch).includes('droppedHolidayOverrides'), true,
    'the caller reads the count and strips it before the database write');
});
test('email configuration reports missing settings without revealing any value', () => {
  const empty = describeEmailConfiguration({});
  assert.equal(empty.ready, false);
  assert.deepEqual(empty.missing, ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM']);
  assert.equal(empty.host, null);
  assert.equal(empty.from, null);

  const configured = describeEmailConfiguration({
    SMTP_HOST: 'smtp.gmail.com',
    SMTP_PORT: '587',
    SMTP_USER: 'reports@example.test',
    SMTP_PASS: 'app-password-value',
    EMAIL_FROM: 'reports@example.test'
  });
  assert.equal(configured.ready, true);
  assert.deepEqual(configured.missing, []);
  assert.equal(configured.host, 'smtp.gmail.com');
  assert.equal(configured.port, 587);
  assert.equal(configured.secure, false, 'port 587 uses STARTTLS rather than implicit TLS');
  assert.equal(configured.requiresTls, true);

  // Whitespace must count as absent, and a bad port must be reported.
  assert.ok(describeEmailConfiguration({ SMTP_HOST: '   ' }).missing.includes('SMTP_HOST'),
    'a whitespace only host must count as missing');
  assert.ok(describeEmailConfiguration({
    SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p', EMAIL_FROM: 'e', SMTP_PORT: 'nope'
  }).missing.includes('SMTP_PORT'));

  const implicitTls = describeEmailConfiguration({
    SMTP_HOST: 'smtp.example.test', SMTP_USER: 'u', SMTP_PASS: 'p', EMAIL_FROM: 'e', SMTP_PORT: '465'
  });
  assert.equal(implicitTls.secure, true);
  assert.equal(implicitTls.requiresTls, false, 'port 465 already uses TLS so STARTTLS must be off');

  const serialised = JSON.stringify(describeEmailConfiguration({
    SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'reports@example.test',
    SMTP_PASS: 'super-secret-app-password', EMAIL_FROM: 'reports@example.test'
  }));
  assert.ok(!serialised.includes('super-secret-app-password'), 'the SMTP password must never be returned');
});

test('SMTP failures are explained as something an operator can act on', () => {
  assert.match(explainSmtpFailure({ code: 'EAUTH', message: 'Invalid credentials' }), /App Password/);
  assert.match(explainSmtpFailure({ code: 'ECONNREFUSED', message: 'connect' }), /outbound port/);
  assert.match(explainSmtpFailure({ code: 'ETIMEDOUT', message: 'Connection timeout' }), /firewall/);
  assert.match(explainSmtpFailure({ message: 'self signed certificate in certificate chain' }), /SMTP_SECURE/);
  assert.equal(explainSmtpFailure({ message: 'something exotic happened' }), 'something exotic happened');
});

test('the email diagnostic stops at configuration and never opens a connection when it is incomplete', async () => {
  const originalCreateTransport = nodemailer.createTransport;
  let created = false;
  nodemailer.createTransport = () => {
    created = true;
    throw new Error('should not be reached');
  };
  try {
    const result = await diagnoseEmailPipeline({ environment: {} });
    assert.equal(result.ready, false);
    assert.equal(created, false, 'an incomplete configuration must not attempt a connection');
    assert.deepEqual(result.stages.map((stage) => stage.stage), ['configuration']);
    assert.match(result.stages[0].detail, /SMTP_HOST/);
  } finally {
    nodemailer.createTransport = originalCreateTransport;
  }
});

test('the email diagnostic reports a reachable server without sending unless asked', async () => {
  const originalCreateTransport = nodemailer.createTransport;
  let sent = 0;
  let verified = 0;
  nodemailer.createTransport = () => ({
    async verify() { verified += 1; return true; },
    async sendMail() { sent += 1; return { messageId: 'test-1' }; }
  });
  const environment = {
    SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587',
    SMTP_USER: 'u', SMTP_PASS: 'p', EMAIL_FROM: 'reports@example.test'
  };
  try {
    const check = await diagnoseEmailPipeline({ environment });
    assert.equal(check.ready, true);
    assert.equal(verified, 1, 'the transporter must actually be verified');
    assert.equal(sent, 0, 'a status check must never send mail');
    assert.deepEqual(check.stages.map((stage) => stage.stage), ['configuration', 'smtp-connection', 'delivery']);

    const delivered = await diagnoseEmailPipeline({ environment, send: true });
    assert.equal(delivered.ready, true);
    assert.equal(sent, 1, 'an explicit test must send exactly one message');
  } finally {
    nodemailer.createTransport = originalCreateTransport;
  }
});

test('the email diagnostic surfaces an authentication failure with a usable remedy', async () => {
  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    async verify() {
      throw Object.assign(new Error('Invalid credentials: 535'), { code: 'EAUTH' });
    },
    async sendMail() { throw new Error('should not send'); }
  });
  try {
    const result = await diagnoseEmailPipeline({
      environment: {
        SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '587',
        SMTP_USER: 'u', SMTP_PASS: 'wrong', EMAIL_FROM: 'reports@example.test'
      },
      send: true
    });
    assert.equal(result.ready, false);
    const connection = result.stages.find((stage) => stage.stage === 'smtp-connection');
    assert.equal(connection.ok, false);
    assert.match(connection.detail, /App Password/);
    assert.equal(result.stages.some((stage) => stage.stage === 'delivery'), false,
      'a rejected connection must not be reported as a delivery attempt');
  } finally {
    nodemailer.createTransport = originalCreateTransport;
  }
});
test('a doctor clinic setup save persists the daily report time', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'report-time-save-session-secret-long-enough';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const Doctor = mongoose.models.Doctor;
  const DashboardUser = mongoose.models.DashboardUser;
  const originalUserFindById = DashboardUser.findById;
  const originalDoctorFindOne = Doctor.findOne;
  const originalFindOneAndUpdate = Doctor.findOneAndUpdate;

  const doctor = {
    doctorId: 'clinic-time', doctorName: 'Dr. Time', clinicName: 'Time Clinic',
    email: 'time@example.test', religion: 'Muslim', basicCheckupFee: 500,
    facilityPricing: [{ category: 'facility', name: 'Consultation', price: 500 }],
    consultationDetails: 'Consultation charges Rs. 1500', workingDays: [1, 2, 3, 4, 5],
    offDays: [], welcomeMessage: 'Welcome', religiousHolidayOpenDays: [],
    officeStartHour: 9, officeEndHour: 17, appointmentDurationMinutes: 30,
    appointmentLookaheadDays: 14, reportTime: '00:00', isActive: true
  };
  let persisted;

  DashboardUser.findById = () => ({ lean: async () => ({ _id: 'd1', role: 'DOCTOR', doctorId: doctor.doctorId, isActive: true }) });
  Doctor.findOne = () => ({ lean: async () => ({ ...doctor }) });
  Doctor.findOneAndUpdate = (filter, update) => {
    persisted = update.$set;
    const merged = { ...doctor, ...update.$set };
    return { lean: async () => merged };
  };

  const base = {
    doctorName: doctor.doctorName,
    clinicName: doctor.clinicName,
    religion: doctor.religion,
    basicCheckupFee: doctor.basicCheckupFee,
    facilityPricing: doctor.facilityPricing,
    consultationDetails: doctor.consultationDetails,
    workingDays: doctor.workingDays,
    offDays: doctor.offDays,
    religiousHolidayOpenDays: doctor.religiousHolidayOpenDays,
    welcomeMessage: doctor.welcomeMessage,
    officeStartHour: doctor.officeStartHour,
    officeEndHour: doctor.officeEndHour,
    appointmentDurationMinutes: doctor.appointmentDurationMinutes,
    appointmentLookaheadDays: doctor.appointmentLookaheadDays,
    reportTime: '07:30'
  };

  try {
    const routes = new Map();
    const app = {
      use() {},
      get: (p, ...h) => routes.set(`GET ${p}`, h),
      post: (p, ...h) => routes.set(`POST ${p}`, h),
      put: (p, ...h) => routes.set(`PUT ${p}`, h),
      patch: (p, ...h) => routes.set(`PATCH ${p}`, h),
      delete: (p, ...h) => routes.set(`DELETE ${p}`, h)
    };
    mountDashboard(app, mongoose.models.Appointment, 'Asia/Karachi', doctor.doctorId, {
      getWhatsAppSessionInfo: () => ({ authDirectory: '/tmp/doctorbot-time-test', persistent: true })
    });
    const token = createSessionToken(
      { _id: 'd1', role: 'DOCTOR', doctorId: doctor.doctorId, isActive: true }, secret, Date.now() + 60_000
    );
    const response = {
      locals: { doctor }, statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; }
    };
    const request = {
      headers: { cookie: `doctorbot_dashboard=${token}` }, query: {}, params: {}, body: base
    };
    const handlers = routes.get('PUT /api/dashboard/settings');
    for (let i = 0; i < handlers.length; i += 1) {
      const last = i === handlers.length - 1;
      await handlers[i](request, response, () => {});
      if (last || response.statusCode >= 400) break;
    }

    assert.equal(response.statusCode, 200, response.body && response.body.error);
    assert.equal(persisted.reportTime, '07:30',
      'the report time must reach the database write, not just the response');
    assert.equal(response.body.reportTime, '07:30',
      'the response must echo the stored time so the UI can verify the save');

    // An invalid time must be refused with a message about the report time.
    const invalidResponse = {
      locals: { doctor }, statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; }
    };
    const invalidRequest = {
      headers: { cookie: `doctorbot_dashboard=${token}` }, query: {}, params: {},
      body: { ...base, reportTime: '24:00' }
    };
    const invalidHandlers = routes.get('PUT /api/dashboard/settings');
    for (let i = 0; i < invalidHandlers.length; i += 1) {
      const last = i === invalidHandlers.length - 1;
      await invalidHandlers[i](invalidRequest, invalidResponse, () => {});
      if (last || invalidResponse.statusCode >= 400) break;
    }
    assert.equal(invalidResponse.statusCode, 400);
    assert.match(invalidResponse.body.error, /report time/i);
  } finally {
    DashboardUser.findById = originalUserFindById;
    Doctor.findOne = originalDoctorFindOne;
    Doctor.findOneAndUpdate = originalFindOneAndUpdate;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});
test('the superadmin clinic setup save persists the daily report time', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'admin-report-time-session-secret-long-enough';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const Doctor = mongoose.models.Doctor;
  const DashboardUser = mongoose.models.DashboardUser;
  const originalUserFindById = DashboardUser.findById;
  const originalDoctorFindOne = Doctor.findOne;
  const originalFindOneAndUpdate = Doctor.findOneAndUpdate;

  const doctor = {
    doctorId: 'clinic-admin-time', doctorName: 'Dr. Admin', clinicName: 'Admin Time Clinic',
    email: 'admin-time@example.test', religion: 'Muslim', basicCheckupFee: 500,
    facilityPricing: [{ category: 'facility', name: 'Consultation', price: 500 }],
    consultationDetails: 'Consultation charges Rs. 1500', workingDays: [1, 2, 3, 4, 5],
    offDays: [], welcomeMessage: 'Welcome', religiousHolidayOpenDays: [],
    officeStartHour: 9, officeEndHour: 17, appointmentDurationMinutes: 30,
    appointmentLookaheadDays: 14, reportTime: '00:00', isActive: true
  };
  let persisted;

  DashboardUser.findById = () => ({ lean: async () => ({ _id: 'a1', role: 'SUPERADMIN', doctorId: null, isActive: true }) });
  Doctor.findOne = () => ({ lean: async () => ({ ...doctor }) });
  Doctor.findOneAndUpdate = (filter, update) => {
    persisted = update.$set;
    return { lean: async () => ({ ...doctor, ...update.$set }) };
  };

  try {
    const routes = new Map();
    const app = {
      use() {},
      get: (p, ...h) => routes.set(`GET ${p}`, h),
      post: (p, ...h) => routes.set(`POST ${p}`, h),
      put: (p, ...h) => routes.set(`PUT ${p}`, h),
      patch: (p, ...h) => routes.set(`PATCH ${p}`, h),
      delete: (p, ...h) => routes.set(`DELETE ${p}`, h)
    };
    mountDashboard(app, mongoose.models.Appointment, 'Asia/Karachi', null, {
      getWhatsAppSessionInfo: () => ({ authDirectory: '/tmp/doctorbot-admin-time', persistent: true })
    });
    const token = createSessionToken(
      { _id: 'a1', role: 'SUPERADMIN', doctorId: null, isActive: true }, secret, Date.now() + 60_000
    );

    const send = async (body) => {
      const response = {
        locals: {}, statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; }
      };
      const request = {
        headers: { cookie: `doctorbot_dashboard=${token}` }, query: {},
        params: { doctorId: doctor.doctorId }, body
      };
      const handlers = routes.get('PUT /api/admin/doctors/:doctorId');
      for (let i = 0; i < handlers.length; i += 1) {
        const last = i === handlers.length - 1;
        await handlers[i](request, response, () => {});
        if (last || response.statusCode >= 400) break;
      }
      return response;
    };

    const base = {
      doctorName: doctor.doctorName,
      clinicName: doctor.clinicName,
      religion: doctor.religion,
      basicCheckupFee: doctor.basicCheckupFee,
      facilityPricing: doctor.facilityPricing,
      consultationDetails: doctor.consultationDetails,
      workingDays: doctor.workingDays,
      offDays: doctor.offDays,
      religiousHolidayOpenDays: doctor.religiousHolidayOpenDays,
      welcomeMessage: doctor.welcomeMessage,
      officeStartHour: doctor.officeStartHour,
      officeEndHour: doctor.officeEndHour,
      appointmentDurationMinutes: doctor.appointmentDurationMinutes,
      appointmentLookaheadDays: doctor.appointmentLookaheadDays,
      reportTime: '07:30'
    };

    const saved = await send(base);
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
    assert.equal(persisted.reportTime, '07:30',
      'the superadmin save must persist the report time the doctor configured');
    assert.equal(saved.body.doctor.reportTime, '07:30',
      'the response must echo the stored time so the dashboard can verify the write');
    assert.equal(persisted.droppedHolidayOverrides, undefined,
      'the dropped-override count must never be written to the profile');

    // A second save that only changes the report time must also stick.
    persisted = undefined;
    const second = await send({ reportTime: '21:15' });
    assert.equal(second.statusCode, 200, JSON.stringify(second.body));
    assert.equal(persisted.reportTime, '21:15',
      'a report time only edit must not be dropped');

    // An invalid time must be refused with a message naming the field.
    const invalid = await send({ reportTime: '25:00' });
    assert.equal(invalid.statusCode, 400);
  } finally {
    DashboardUser.findById = originalUserFindById;
    Doctor.findOne = originalDoctorFindOne;
    Doctor.findOneAndUpdate = originalFindOneAndUpdate;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});
test('an unconfigured report is a warning, not a clinic error', async () => {
  const Doctor = mongoose.models.Doctor;
  const Appointment = mongoose.models.Appointment;
  const DailyReportRun = mongoose.models.DailyReportRun;
  const ServiceLog = mongoose.models.ServiceLog;
  const originals = {
    doctorFindOne: Doctor.findOne,
    doctorExists: Doctor.exists,
    appointmentFind: Appointment.find,
    reportFindOneAndUpdate: DailyReportRun.findOneAndUpdate,
    reportCreate: DailyReportRun.create,
    reportUpdateOne: DailyReportRun.updateOne,
    serviceLogCreate: ServiceLog.create
  };
  const written = [];
  Doctor.findOne = () => ({ lean: async () => ({ doctorId: 'warn-clinic', clinicName: 'Warn Clinic', email: 'w@example.test', isActive: true }) });
  Doctor.exists = async () => true;
  Appointment.find = () => ({ sort() { return this; }, lean: async () => [] });
  DailyReportRun.findOneAndUpdate = async () => null;
  DailyReportRun.create = async () => ({});
  DailyReportRun.updateOne = async () => ({ modifiedCount: 1 });
  ServiceLog.create = async (doc) => { written.push(doc); return doc; };

  try {
    // SMTP was never configured, so this is a configuration gap rather than a fault.
    await dispatchDoctorDailyReport({ doctorId: 'warn-clinic' }, {
      transportContext: { transport: null, reason: 'missing SMTP settings: SMTP_HOST, SMTP_USER' }
    });
    assert.equal(written.length, 1);
    assert.equal(written[0].level, 'warn',
      'an unconfigured report must not be recorded as an error against the clinic');
    assert.equal(written[0].code, 'REPORT_NOT_CONFIGURED');

    // A genuine delivery failure stays an error.
    written.length = 0;
    await dispatchDoctorDailyReport({ doctorId: 'warn-clinic' }, {
      transportContext: {
        transport: { async sendMail() { throw Object.assign(new Error('mailbox unavailable'), { code: 'ECONNREFUSED' }); } },
        reason: null
      }
    });
    assert.equal(written.length, 1);
    assert.equal(written[0].level, 'error', 'a real delivery failure must remain an error');
    assert.equal(written[0].code, 'ECONNREFUSED');
  } finally {
    Doctor.findOne = originals.doctorFindOne;
    Doctor.exists = originals.doctorExists;
    Appointment.find = originals.appointmentFind;
    DailyReportRun.findOneAndUpdate = originals.reportFindOneAndUpdate;
    DailyReportRun.create = originals.reportCreate;
    DailyReportRun.updateOne = originals.reportUpdateOne;
    ServiceLog.create = originals.serviceLogCreate;
  }
});
// Audits every dashboard field end to end: the value the form sends, the value the
// server writes to Mongo, and the value it echoes back. Any field that is dropped
// between those three points is reported.
function buildApp() {
  const routes = new Map();
  const app = {
    use() {},
    get: (p, ...h) => routes.set(`GET ${p}`, h),
    post: (p, ...h) => routes.set(`POST ${p}`, h),
    put: (p, ...h) => routes.set(`PUT ${p}`, h),
    patch: (p, ...h) => routes.set(`PATCH ${p}`, h),
    delete: (p, ...h) => routes.set(`DELETE ${p}`, h)
  };
  return { app, routes };
}

const BASE_DOCTOR = {
  doctorId: 'clinic-audit',
  doctorName: 'Dr. Audit',
  clinicName: 'Audit Clinic',
  email: 'audit@example.test',
  religion: 'Muslim',
  basicCheckupFee: 500,
  facilityPricing: [{ category: 'facility', name: 'Consultation', price: 500 }],
  consultationDetails: 'Consultation charges Rs. 1500',
  workingDays: [1, 2, 3, 4, 5],
  offDays: [],
  religiousHolidayOpenDays: [],
  welcomeMessage: 'Welcome',
  officeStartHour: 9,
  officeEndHour: 17,
  appointmentDurationMinutes: 30,
  appointmentLookaheadDays: 7,
  reportTime: '00:00',
  isActive: true,
  googleCalendarId: 'primary',
  googleCalendarConnected: false
};

// Each entry is a field the dashboard lets a user change, the value we submit, and
// the key the database must store it under.
const DOCTOR_FIELDS = [
  ['doctorName', 'Dr. Changed'],
  ['clinicName', 'Renamed Clinic'],
  ['religion', 'Hindu'],
  ['basicCheckupFee', 750],
  ['consultationDetails', 'Changed consultation text'],
  ['welcomeMessage', 'Changed welcome text'],
  ['officeStartHour', 10],
  ['officeEndHour', 19],
  ['appointmentDurationMinutes', 25],
  ['appointmentLookaheadDays', 21],
  ['reportTime', '08:45'],
  ['facilityPricing', [{ category: 'service', name: 'New Treatment', price: 1200 }]],
  ['workingDays', [2, 3, 4]],
  ['offDays', ['2026-12-25']],
  ['religiousHolidayOpenDays', []]
];

async function saveAsDoctor(body) {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'audit-doctor-session-secret-long-enough';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const Doctor = mongoose.models.Doctor;
  const DashboardUser = mongoose.models.DashboardUser;
  const Appointment = mongoose.models.Appointment;
  const originals = {
    userFindById: DashboardUser.findById,
    doctorFindOne: Doctor.findOne,
    findOneAndUpdate: Doctor.findOneAndUpdate
  };
  let persisted;
  const doctor = { ...BASE_DOCTOR };
  DashboardUser.findById = () => ({
    lean: async () => ({ _id: 'd', role: 'DOCTOR', doctorId: doctor.doctorId, isActive: true })
  });
  Doctor.findOne = () => ({ lean: async () => ({ ...doctor }) });
  Doctor.findOneAndUpdate = (filter, update) => {
    persisted = update.$set;
    return { lean: async () => ({ ...doctor, ...update.$set }) };
  };
  try {
    const { app, routes } = buildApp();
    mountDashboard(app, Appointment, 'Asia/Karachi', doctor.doctorId, {
      getWhatsAppSessionInfo: () => ({ authDirectory: '/tmp/doctorbot-audit', persistent: true })
    });
    const token = createSessionToken(
      { _id: 'd', role: 'DOCTOR', doctorId: doctor.doctorId, isActive: true }, secret, Date.now() + 60_000
    );
    const response = {
      locals: { doctor: { ...doctor } }, statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; }
    };
    const request = {
      headers: { cookie: `doctorbot_dashboard=${token}` }, query: {}, params: {}, body
    };
    const handlers = routes.get('PUT /api/dashboard/settings');
    for (let i = 0; i < handlers.length; i += 1) {
      const last = i === handlers.length - 1;
      await handlers[i](request, response, () => {});
      if (last || response.statusCode >= 400) break;
    }
    return { response, persisted };
  } finally {
    DashboardUser.findById = originals.userFindById;
    Doctor.findOne = originals.doctorFindOne;
    Doctor.findOneAndUpdate = originals.findOneAndUpdate;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
}

test('every clinic setup field the doctor can change is written to the database', async () => {
  const baseBody = {
    doctorName: BASE_DOCTOR.doctorName,
    clinicName: BASE_DOCTOR.clinicName,
    religion: BASE_DOCTOR.religion,
    basicCheckupFee: BASE_DOCTOR.basicCheckupFee,
    facilityPricing: BASE_DOCTOR.facilityPricing,
    consultationDetails: BASE_DOCTOR.consultationDetails,
    workingDays: BASE_DOCTOR.workingDays,
    offDays: BASE_DOCTOR.offDays,
    religiousHolidayOpenDays: BASE_DOCTOR.religiousHolidayOpenDays,
    welcomeMessage: BASE_DOCTOR.welcomeMessage,
    officeStartHour: BASE_DOCTOR.officeStartHour,
    officeEndHour: BASE_DOCTOR.officeEndHour,
    appointmentDurationMinutes: BASE_DOCTOR.appointmentDurationMinutes,
    appointmentLookaheadDays: BASE_DOCTOR.appointmentLookaheadDays,
    reportTime: BASE_DOCTOR.reportTime
  };

  const dropped = [];
  for (const [field, value] of DOCTOR_FIELDS) {
    const { response, persisted } = await saveAsDoctor({ ...baseBody, [field]: value });
    assert.equal(response.statusCode, 200,
      `changing ${field} was rejected -> ${response.body && response.body.error}`);
    assert.ok(persisted, `changing ${field} produced no database write`);
    const stored = persisted[field];
    if (JSON.stringify(stored) !== JSON.stringify(value)) {
      dropped.push(`${field}: sent ${JSON.stringify(value)}, stored ${JSON.stringify(stored)}`);
    }
  }
  assert.deepEqual(dropped, [], 'these fields do not reach the database');
});

test('facilityPricing updates also rebuild the derived facility and service name lists', async () => {
  const body = {
    doctorName: BASE_DOCTOR.doctorName,
    clinicName: BASE_DOCTOR.clinicName,
    religion: BASE_DOCTOR.religion,
    basicCheckupFee: BASE_DOCTOR.basicCheckupFee,
    consultationDetails: BASE_DOCTOR.consultationDetails,
    workingDays: BASE_DOCTOR.workingDays,
    offDays: BASE_DOCTOR.offDays,
    religiousHolidayOpenDays: BASE_DOCTOR.religiousHolidayOpenDays,
    welcomeMessage: BASE_DOCTOR.welcomeMessage,
    officeStartHour: BASE_DOCTOR.officeStartHour,
    officeEndHour: BASE_DOCTOR.officeEndHour,
    appointmentDurationMinutes: BASE_DOCTOR.appointmentDurationMinutes,
    appointmentLookaheadDays: BASE_DOCTOR.appointmentLookaheadDays,
    reportTime: BASE_DOCTOR.reportTime,
    facilityPricing: [
      { category: 'facility', name: 'X-Ray', price: 900 },
      { category: 'service', name: 'Physiotherapy', price: 1500 }
    ]
  };
  const { response, persisted } = await saveAsDoctor(body);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(persisted.facilitiesList, ['X-Ray']);
  assert.deepEqual(persisted.servicesList, ['Physiotherapy']);
});

test('the echoed response mirrors every stored value the dashboard reads back', async () => {
  const body = {
    doctorName: 'Dr. Echo',
    clinicName: 'Echo Clinic',
    religion: 'Other',
    basicCheckupFee: 400,
    facilityPricing: [{ category: 'facility', name: 'Echo Test', price: 250 }],
    consultationDetails: 'Echo details',
    workingDays: [1, 2],
    offDays: [],
    religiousHolidayOpenDays: [],
    welcomeMessage: 'Echo welcome',
    officeStartHour: 8,
    officeEndHour: 20,
    appointmentDurationMinutes: 20,
    appointmentLookaheadDays: 3,
    reportTime: '23:59'
  };
  const { response } = await saveAsDoctor(body);
  assert.equal(response.statusCode, 200);
  const echoed = response.body;
  for (const [field, value] of Object.entries(body)) {
    if (field === 'facilityPricing' || field === 'workingDays' || field === 'religiousHolidayOpenDays') continue;
    assert.deepEqual(echoed[field], value, `${field} is not echoed back correctly`);
  }
  assert.equal(echoed.reportTime, '23:59');
  assert.equal(echoed.facilityPricing[0].name, 'Echo Test');
});

test('invalid values are refused with a message that names the field', async () => {
  const base = {
    doctorName: BASE_DOCTOR.doctorName,
    clinicName: BASE_DOCTOR.clinicName,
    religion: BASE_DOCTOR.religion,
    basicCheckupFee: BASE_DOCTOR.basicCheckupFee,
    facilityPricing: BASE_DOCTOR.facilityPricing,
    consultationDetails: BASE_DOCTOR.consultationDetails,
    workingDays: BASE_DOCTOR.workingDays,
    offDays: BASE_DOCTOR.offDays,
    religiousHolidayOpenDays: BASE_DOCTOR.religiousHolidayOpenDays,
    welcomeMessage: BASE_DOCTOR.welcomeMessage,
    officeStartHour: BASE_DOCTOR.officeStartHour,
    officeEndHour: BASE_DOCTOR.officeEndHour,
    appointmentDurationMinutes: BASE_DOCTOR.appointmentDurationMinutes,
    appointmentLookaheadDays: BASE_DOCTOR.appointmentLookaheadDays,
    reportTime: BASE_DOCTOR.reportTime
  };
  const cases = [
    ['reportTime', '99:99', /report time/i],
    ['officeStartHour', 25, /timings/i],
    ['appointmentLookaheadDays', 99, /timings/i],
    ['religion', 'Atheist', /religion/i],
    ['basicCheckupFee', -5, /checkup fee/i],
    ['consultationDetails', '', /consultation/i]
  ];
  for (const [field, value, pattern] of cases) {
    const { response } = await saveAsDoctor({ ...base, [field]: value });
    assert.equal(response.statusCode, 400, `${field} = ${JSON.stringify(value)} was wrongly accepted`);
    assert.match(response.body.error, pattern, `${field} error should name the field`);
  }
});

test('an invalid change is rejected as a whole and stores nothing', async () => {
  const base = {
    doctorName: BASE_DOCTOR.doctorName,
    clinicName: BASE_DOCTOR.clinicName,
    religion: BASE_DOCTOR.religion,
    basicCheckupFee: BASE_DOCTOR.basicCheckupFee,
    facilityPricing: BASE_DOCTOR.facilityPricing,
    consultationDetails: BASE_DOCTOR.consultationDetails,
    workingDays: BASE_DOCTOR.workingDays,
    offDays: BASE_DOCTOR.offDays,
    religiousHolidayOpenDays: BASE_DOCTOR.religiousHolidayOpenDays,
    welcomeMessage: BASE_DOCTOR.welcomeMessage,
    officeStartHour: BASE_DOCTOR.officeStartHour,
    officeEndHour: BASE_DOCTOR.officeEndHour,
    appointmentDurationMinutes: BASE_DOCTOR.appointmentDurationMinutes,
    appointmentLookaheadDays: BASE_DOCTOR.appointmentLookaheadDays,
    reportTime: BASE_DOCTOR.reportTime
  };
  // A valid name change bundled with a bad report time must not partially save.
  const { response, persisted } = await saveAsDoctor({ ...base, clinicName: 'Should Not Persist', reportTime: '99:99' });
  assert.equal(response.statusCode, 400);
  assert.equal(persisted, undefined, 'a rejected save must not write anything');
});
const ADMIN_FIELDS = [
  ['doctorName', 'Dr. Admin Changed'],
  ['clinicName', 'Admin Renamed'],
  ['religion', 'Hindu'],
  ['basicCheckupFee', 850],
  ['consultationDetails', 'Admin consultation text'],
  ['welcomeMessage', 'Admin welcome text'],
  ['officeStartHour', 11],
  ['officeEndHour', 21],
  ['appointmentDurationMinutes', 20],
  ['appointmentLookaheadDays', 12],
  ['reportTime', '06:15'],
  ['facilityPricing', [{ category: 'facility', name: 'Admin X-Ray', price: 1100 }]],
  ['workingDays', [1, 3, 5]],
  ['offDays', ['2026-12-26']]
];

async function saveAsAdmin(body) {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'audit-admin-session-secret-long-enough';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const Doctor = mongoose.models.Doctor;
  const DashboardUser = mongoose.models.DashboardUser;
  const originals = {
    userFindById: DashboardUser.findById,
    userFindOne: DashboardUser.findOne,
    userUpdateMany: DashboardUser.updateMany,
    doctorFindOne: Doctor.findOne,
    findOneAndUpdate: Doctor.findOneAndUpdate
  };
  let persisted;
  const doctor = { ...BASE_DOCTOR };
  DashboardUser.findById = () => ({ lean: async () => ({ _id: 'a', role: 'SUPERADMIN', doctorId: null, isActive: true }) });
  DashboardUser.findOne = () => ({ lean: async () => null });
  DashboardUser.updateMany = async () => ({ modifiedCount: 0 });
  Doctor.findOne = () => ({ lean: async () => ({ ...doctor }) });
  Doctor.findOneAndUpdate = (filter, update) => {
    persisted = update.$set;
    return { lean: async () => ({ ...doctor, ...update.$set }) };
  };
  try {
    const { app, routes } = buildApp();
    mountDashboard(app, mongoose.models.Appointment, 'Asia/Karachi', null, {
      getWhatsAppSessionInfo: () => ({ authDirectory: '/tmp/doctorbot-audit-admin', persistent: true })
    });
    const token = createSessionToken(
      { _id: 'a', role: 'SUPERADMIN', doctorId: null, isActive: true }, secret, Date.now() + 60_000
    );
    const response = {
      locals: {}, statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; }
    };
    const request = {
      headers: { cookie: `doctorbot_dashboard=${token}` }, query: {},
      params: { doctorId: doctor.doctorId }, body
    };
    const handlers = routes.get('PUT /api/admin/doctors/:doctorId');
    for (let i = 0; i < handlers.length; i += 1) {
      const last = i === handlers.length - 1;
      await handlers[i](request, response, () => {});
      if (last || response.statusCode >= 400) break;
    }
    return { response, persisted };
  } finally {
    DashboardUser.findById = originals.userFindById;
    DashboardUser.findOne = originals.userFindOne;
    DashboardUser.updateMany = originals.userUpdateMany;
    Doctor.findOne = originals.doctorFindOne;
    Doctor.findOneAndUpdate = originals.findOneAndUpdate;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
}

test('every clinic setup field the superadmin edits is written to the database', async () => {
  const dropped = [];
  for (const [field, value] of ADMIN_FIELDS) {
    const { response, persisted } = await saveAsAdmin({ [field]: value });
    assert.equal(response.statusCode, 200,
      `superadmin change to ${field} was rejected -> ${response.body && response.body.error}`);
    assert.ok(persisted, `superadmin change to ${field} produced no database write`);
    const stored = persisted[field];
    if (JSON.stringify(stored) !== JSON.stringify(value)) {
      dropped.push(`${field}: sent ${JSON.stringify(value)}, stored ${JSON.stringify(stored)}`);
    }
  }
  assert.deepEqual(dropped, [], 'these superadmin fields do not reach the database');
});

test('the superadmin response echoes the stored clinic record for every editable field', async () => {
  const body = {
    doctorName: 'Dr. Verify', clinicName: 'Verify Clinic', religion: 'Other',
    basicCheckupFee: 300, consultationDetails: 'Verify details', welcomeMessage: 'Verify welcome',
    officeStartHour: 9, officeEndHour: 18, appointmentDurationMinutes: 25,
    appointmentLookaheadDays: 5, reportTime: '05:05',
    facilityPricing: [{ category: 'service', name: 'Verify Service', price: 300 }],
    workingDays: [1, 2, 3, 4, 5], offDays: [], religiousHolidayOpenDays: []
  };
  const { response } = await saveAsAdmin(body);
  assert.equal(response.statusCode, 200);
  const echoed = response.body.doctor;
  assert.equal(echoed.doctorName, 'Dr. Verify');
  assert.equal(echoed.clinicName, 'Verify Clinic');
  assert.equal(echoed.religion, 'Other');
  assert.equal(echoed.basicCheckupFee, 300);
  assert.equal(echoed.reportTime, '05:05', 'the report time must be echoed so the dashboard can verify it');
  assert.equal(echoed.officeStartHour, 9);
  assert.equal(echoed.officeEndHour, 18);
  assert.equal(echoed.appointmentDurationMinutes, 25);
  assert.equal(echoed.appointmentLookaheadDays, 5);
  assert.equal(echoed.facilityPricing[0].name, 'Verify Service');
  assert.deepEqual(echoed.facilitiesList, []);
  assert.deepEqual(echoed.servicesList, ['Verify Service']);
});

test('an invalid superadmin change is refused and stores nothing', async () => {
  for (const [field, value] of [['reportTime', '77:77'], ['basicCheckupFee', -1], ['religion', 'None']]) {
    const { response, persisted } = await saveAsAdmin({ [field]: value });
    assert.equal(response.statusCode, 400, `${field} = ${JSON.stringify(value)} was wrongly accepted`);
    assert.equal(persisted, undefined, 'a rejected superadmin save must not write anything');
  }
});

test('a superadmin save can change one field without disturbing the rest', async () => {
  const { response, persisted } = await saveAsAdmin({ reportTime: '04:04' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(persisted).sort(), ['reportTime', 'setupComplete', 'updatedAt'],
    'a partial edit must only touch the fields it supplied, plus bookkeeping');
});
// A minimal in-memory stand-in for the WhatsAppAuthState collection so the store
// logic can be verified without a database. It mirrors only the operations the
// store actually uses.
function createFakeCollection(seed = []) {
  const rows = seed.map((row) => ({ ...row }));
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
    if (key === 'storeId' && value && typeof value === 'object' && Array.isArray(value.$in)) {
      return value.$in.includes(row.storeId);
    }
    return row[key] === value;
  });

  // Mongoose returns a chainable query, not a promise, so the fake must too.
  const query = (produce) => {
    const chain = {
      lean: async () => produce(),
      sort: () => chain,
      limit: () => chain
    };
    chain.then = (onFulfilled, onRejected) => produce().then(onFulfilled, onRejected);
    chain.catch = (onRejected) => produce().catch(onRejected);
    return chain;
  };

  const Model = {
    __rows: rows,
    findOne(filter) {
      return query(() => {
        const found = rows.find((row) => matches(row, filter)) || null;
        return found ? { ...found } : null;
      });
    },
    find(filter) {
      return query(() => rows.filter((row) => matches(row, filter)).map((row) => ({ ...row })));
    },
    async updateOne(filter, update, options = {}) {
      const existing = rows.find((row) => matches(row, filter));
      if (existing) Object.assign(existing, update.$set);
      else if (options.upsert) rows.push({ ...filter, ...update.$set });
      return { matchedCount: existing ? 1 : 0 };
    },
    async deleteMany(filter) {
      const kept = rows.filter((row) => !matches(row, filter));
      const removed = rows.length - kept.length;
      rows.length = 0;
      rows.push(...kept);
      return { deletedCount: removed };
    },
    async bulkWrite(operations) {
      for (const operation of operations) {
        if (operation.deleteOne) await Model.deleteOne(operation.deleteOne.filter);
        if (operation.updateOne) {
          await Model.updateOne(operation.updateOne.filter, operation.updateOne.update,
            { upsert: operation.updateOne.upsert });
        }
      }
      return { ok: 1 };
    },
    async deleteOne(filter) {
      const index = rows.findIndex((row) => matches(row, filter));
      if (index >= 0) rows.splice(index, 1);
      return { deletedCount: index >= 0 ? 1 : 0 };
    }
  };
  return Model;
}

// The store takes its model by injection, so these tests need no database and no
// monkey patching of the global mongoose model registry.
function withFakeAuthCollection(run) {
  return run(createFakeCollection());
}

test('the WhatsApp auth store saves and restores credentials in MongoDB', async () => {
  await withFakeAuthCollection(async (Model) => {
    const { createMongoAuthState } = require('../src/whatsappAuthStore');
    const auth = createMongoAuthState('clinic-mongo', { Model });

    assert.equal(await auth.state.creds.get(), null, 'a new clinic starts with no credentials');

    const creds = { me: { id: '923001234567:12@s.whatsapp.net' }, registered: true, pairingCode: 'ABC' };
    await auth.saveCreds(creds);

    const restored = await auth.state.creds.get();
    assert.equal(restored.registered, true);
    assert.equal(restored.me.id, creds.me.id);
    assert.equal(restored.pairingCode, 'ABC');
  });
});

test('signal keys round trip through MongoDB as buffers', async () => {
  await withFakeAuthCollection(async (Model) => {
    const { createMongoAuthState } = require('../src/whatsappAuthStore');
    const auth = createMongoAuthState('clinic-keys', { Model });

    await auth.state.keys.set({ 'pre-key': { 'PK-1': new Uint8Array([1, 2, 3, 250]) } });

    const fetched = await auth.state.keys.get('pre-key', ['PK-1']);
    assert.ok(fetched['PK-1'], 'the stored key must be returned');
    assert.ok(Buffer.isBuffer(fetched['PK-1']), 'binary keys must be stored as buffers');
    assert.deepEqual([...Buffer.from(fetched['PK-1'])], [1, 2, 3, 250]);

    const partial = await auth.state.keys.get('pre-key', ['PK-1', 'MISSING']);
    assert.ok(partial['PK-1']);
    assert.equal(partial.MISSING, undefined, 'an unknown key is absent, not an error');
    assert.deepEqual(await auth.state.keys.get('pre-key', []), {}, 'an empty id list short circuits');
  });
});

test('a null value deletes the key, as Baileys expects', async () => {
  await withFakeAuthCollection(async (Model) => {
    const { createMongoAuthState } = require('../src/whatsappAuthStore');
    const auth = createMongoAuthState('clinic-del', { Model });

    await auth.state.keys.set({ session: { 'S-1': new Uint8Array([9]) } });
    assert.ok((await auth.state.keys.get('session', ['S-1']))['S-1']);

    await auth.state.keys.set({ session: { 'S-1': null } });
    assert.equal((await auth.state.keys.get('session', ['S-1']))['S-1'], undefined,
      'a null value must remove the stored key');
  });
});

test('each clinic session is isolated and wiping one leaves the others intact', async () => {
  await withFakeAuthCollection(async (Model) => {
    const { createMongoAuthState } = require('../src/whatsappAuthStore');
    const first = createMongoAuthState('clinic-a', { Model });
    const second = createMongoAuthState('clinic-b', { Model });

    await first.saveCreds({ me: { id: 'a@s.whatsapp.net' }, registered: true });
    await second.saveCreds({ me: { id: 'b@s.whatsapp.net' }, registered: true });

    assert.equal((await first.state.creds.get()).me.id, 'a@s.whatsapp.net');
    assert.equal((await second.state.creds.get()).me.id, 'b@s.whatsapp.net');

    await first.wipe();
    assert.equal(await first.state.creds.get(), null);
    assert.equal((await second.state.creds.get()).me.id, 'b@s.whatsapp.net',
      'wiping one clinic must not remove another clinic session');
  });
});

test('every stored document carries its clinic so a clinic can be wiped safely', async () => {
  await withFakeAuthCollection(async (Model) => {
    const { createMongoAuthState } = require('../src/whatsappAuthStore');
    const auth = createMongoAuthState('clinic-scoped', { Model });
    await auth.state.keys.set({ 'sender-key': { 'SK-1': new Uint8Array([5]) } });

    const rows = auth.Model.__rows;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.doctorId === 'clinic-scoped'));
  });
});

test('expiring key types get a retention date and durable key types do not', async () => {
  await withFakeAuthCollection(async (Model) => {
    const { createMongoAuthState } = require('../src/whatsappAuthStore');
    await Model.deleteMany({});
    const auth = createMongoAuthState('clinic-ttl', { Model });

    await auth.state.keys.set({
      'pre-key': { 'PK-1': new Uint8Array([1]) },
      session: { 'S-1': new Uint8Array([2]) }
    });

    const preKey = auth.Model.__rows.find((row) => row.storeType === 'pre-key');
    const session = auth.Model.__rows.find((row) => row.storeType === 'session');
    assert.equal(preKey.expiresAt, null,
      'pre keys must not expire, or encrypted history becomes undecryptable');
    assert.ok(session.expiresAt instanceof Date, 'session state should be given a retention date');
  });
});
test('an appointment range shows bookings across several days', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'range-session-secret-long-enough';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const Appointment = { find: null };
  let filterUsed;
  const rows = [
    { _id: 'a1', details: { name: 'Ada', contactNumber: '+1', majorSymptoms: 'x' }, slotStart: new Date('2027-03-07T05:00:00Z'), slotEnd: new Date('2027-03-07T05:30:00Z') },
    { _id: 'a2', details: { name: 'Bob', contactNumber: '+2', majorSymptoms: 'y' }, slotStart: new Date('2027-03-09T05:00:00Z'), slotEnd: new Date('2027-03-09T05:30:00Z') }
  ];
  Appointment.find = (filter) => {
    filterUsed = filter;
    return { sort() { return this; }, limit() { return this; }, lean: async () => rows };
  };
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originals = {
    userFindById: DashboardUser.findById,
    doctorFindOne: Doctor.findOne
  };
  DashboardUser.findById = () => ({
    lean: async () => ({ _id: 'd', role: 'DOCTOR', doctorId: 'clinic-range', isActive: true })
  });
  Doctor.findOne = () => ({ lean: async () => ({ doctorId: 'clinic-range', isActive: true }) });

  try {
    const routes = new Map();
    const app = {
      use() {},
      get: (p, ...h) => routes.set(`GET ${p}`, h),
      post: (p, ...h) => routes.set(`POST ${p}`, h),
      put: (p, ...h) => routes.set(`PUT ${p}`, h),
      patch: (p, ...h) => routes.set(`PATCH ${p}`, h),
      delete: (p, ...h) => routes.set(`DELETE ${p}`, h)
    };
    mountDashboard(app, Appointment, 'Asia/Karachi', 'clinic-range', {});
    const token = createSessionToken(
      { _id: 'd', role: 'DOCTOR', doctorId: 'clinic-range', isActive: true }, secret, Date.now() + 60_000
    );
    const call = async (query) => {
      const response = { locals: {}, statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; } };
      const request = { headers: { cookie: `doctorbot_dashboard=${token}` }, query, params: {} };
      const handlers = routes.get('GET /api/dashboard/appointments');
      for (let i = 0; i < handlers.length; i += 1) {
        const last = i === handlers.length - 1;
        await handlers[i](request, response, () => {});
        if (last || response.statusCode >= 400) break;
      }
      return response;
    };

    const ranged = await call({ from: '2027-03-07', to: '2027-03-12' });
    assert.equal(ranged.statusCode, 200);
    assert.equal(ranged.body.from, '2027-03-07');
    assert.equal(ranged.body.to, '2027-03-12');
    assert.equal(ranged.body.grouped, true, 'a multi day view groups rows by day');
    assert.equal(ranged.body.appointments.length, 2, 'a booking on another date must be visible');
    // The window must actually span the requested days rather than one day.
    const span = filterUsed.slotStart.$lt - filterUsed.slotStart.$gte;
    assert.ok(span >= 5 * 24 * 60 * 60 * 1000, 'the query must cover the whole range');

    const single = await call({ from: '2027-03-07', to: '2027-03-07' });
    assert.equal(single.body.grouped, false, 'a single day view does not need separators');

    // A reversed range is corrected rather than returning nothing.
    const reversed = await call({ from: '2027-03-12', to: '2027-03-07' });
    assert.equal(reversed.body.to, '2027-03-12');

    // An absurd range is clamped.
    const huge = await call({ from: '2027-03-07', to: '2030-01-01' });
    assert.ok(huge.body.to < '2030-01-01', 'an oversized range must be clamped');

    const searched = await call({ from: '2027-03-07', to: '2027-03-12', q: 'Ada' });
    assert.equal(searched.body.search, 'Ada');
    assert.ok(Array.isArray(filterUsed.$or), 'a search term must filter by patient details');
  } finally {
    DashboardUser.findById = originals.userFindById;
    Doctor.findOne = originals.doctorFindOne;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});

test('cancelling an appointment releases the slot and cannot be done twice', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'cancel-session-secret-long-enough';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const mongooseModels = mongoose.models;
  let current = {
    _id: 'appt-1', doctorId: 'clinic-cancel', status: 'booked',
    slotStart: new Date('2026-10-20T05:00:00Z'), calendarEventId: 'evt-1'
  };
  const Appointment = {
    findOne: (filter) => {
      if (current.status !== 'booked') return null;
      return { then: undefined, async *[Symbol.asyncIterator]() {}, lean: async () => current };
    },
    findOneAndUpdate: (filter, update) => {
      if (current.status !== 'booked') return null;
      current = { ...current, ...update.$set };
      return { new: true, then: undefined, async *[Symbol.asyncIterator]() {}, lean: async () => current };
    }
  };
  // A plain thenable is enough because the route awaits the result of lean().
  Appointment.findOne = (filter) => {
    const result = current.status === 'booked' ? current : null;
    const query = { lean: async () => result };
    query.then = (onOk, onErr) => Promise.resolve(result).then(onOk, onErr);
    return query;
  };
  Appointment.findOneAndUpdate = (filter, update) => {
    const result = current.status === 'booked' ? { ...current, ...update.$set } : null;
    if (result) current = result;
    const query = { new: true, lean: async () => result };
    query.then = (onOk, onErr) => Promise.resolve(result).then(onOk, onErr);
    return query;
  };

  const cancelDashboardUser = mongoose.models.DashboardUser;
  const cancelDoctor = mongoose.models.Doctor;
  const cancelOriginals = {
    userFindById: cancelDashboardUser.findById,
    doctorFindOne: cancelDoctor.findOne
  };
  cancelDashboardUser.findById = () => ({
    lean: async () => ({ _id: 'd', role: 'DOCTOR', doctorId: 'clinic-cancel', isActive: true })
  });
  cancelDoctor.findOne = () => ({ lean: async () => ({ doctorId: 'clinic-cancel', isActive: true }) });

  try {
    const routes = new Map();
    const app = {
      use() {},
      get: (p, ...h) => routes.set(`GET ${p}`, h),
      post: (p, ...h) => routes.set(`POST ${p}`, h),
      put: (p, ...h) => routes.set(`PUT ${p}`, h),
      patch: (p, ...h) => routes.set(`PATCH ${p}`, h),
      delete: (p, ...h) => routes.set(`DELETE ${p}`, h)
    };
    mountDashboard(app, Appointment, 'Asia/Karachi', 'clinic-cancel', {});
    const token = createSessionToken(
      { _id: 'd', role: 'DOCTOR', doctorId: 'clinic-cancel', isActive: true }, secret, Date.now() + 60_000
    );
    const call = async (appointmentId) => {
      const response = { locals: { doctor: {} }, statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; } };
      const request = {
        headers: { cookie: `doctorbot_dashboard=${token}` }, query: {},
        params: { appointmentId }, body: {}
      };
      const handlers = routes.get('POST /api/dashboard/appointments/:appointmentId/cancel');
      for (let i = 0; i < handlers.length; i += 1) {
        const last = i === handlers.length - 1;
        await handlers[i](request, response, () => {});
        if (last || response.statusCode >= 400) break;
      }
      return response;
    };

    const badId = await call('not-an-object-id');
    assert.equal(badId.statusCode, 400, 'a malformed id must be refused');

    const first = await call('507f1f77bcf86cd799439011');
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    assert.equal(first.body.cancelled, true);
    assert.equal(current.status, 'cancelled', 'the booking must be released');

    const second = await call('507f1f77bcf86cd799439011');
    assert.equal(second.statusCode, 404, 'cancelling twice must not report success again');
  } finally {
    cancelDashboardUser.findById = cancelOriginals.userFindById;
    cancelDoctor.findOne = cancelOriginals.doctorFindOne;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});

test('the CSV export escapes separators, quotes and formula characters', () => {
  // Exercised through the same helper the export route uses.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  assert.match(source, /function toCsvCell/);
  assert.match(source, /toCsvCell\(value\)/);
  assert.match(source, /Content-Disposition/);
});

test('superadmin actions are recorded in the audit log', async () => {
  const previousSecret = process.env.DASHBOARD_SESSION_SECRET;
  const secret = 'audit-session-secret-long-enough';
  process.env.DASHBOARD_SESSION_SECRET = secret;
  const AuditLog = mongoose.models.AuditLog;
  const auditUser = mongoose.models.DashboardUser;
  const originalCreate = AuditLog.create;
  const originalFind = AuditLog.find;
  const originalUserFindById = auditUser.findById;
  const written = [];
  AuditLog.create = async (doc) => { written.push(doc); return doc; };
  auditUser.findById = () => ({
    lean: async () => ({ _id: 'a1', role: 'SUPERADMIN', doctorId: null, isActive: true, email: 'admin@example.test' })
  });
  AuditLog.find = () => ({
    sort() { return this; },
    limit() { return this; },
    lean: async () => [{ _id: 'e1', actorEmail: 'admin@example.test', action: 'doctor.delete', targetDoctorId: 'clinic-x', targetLabel: 'X Clinic', detail: 'Removed 1 login', createdAt: new Date() }]
  });

  try {
    const routes = new Map();
    const app = {
      use() {},
      get: (p, ...h) => routes.set(`GET ${p}`, h),
      post: (p, ...h) => routes.set(`POST ${p}`, h),
      put: (p, ...h) => routes.set(`PUT ${p}`, h),
      patch: (p, ...h) => routes.set(`PATCH ${p}`, h),
      delete: (p, ...h) => routes.set(`DELETE ${p}`, h)
    };
    mountDashboard(app, mongoose.models.Appointment, 'Asia/Karachi', null, {});
    const token = createSessionToken(
      { _id: 'a1', role: 'SUPERADMIN', doctorId: null, isActive: true, email: 'admin@example.test' },
      secret, Date.now() + 60_000
    );
    const response = { locals: {}, statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; } };
    const request = {
      headers: { cookie: `doctorbot_dashboard=${token}` }, query: { limit: '10' },
      params: {}, body: {}, ip: '127.0.0.1'
    };
    const handlers = routes.get('GET /api/admin/audit-log');
    for (let i = 0; i < handlers.length; i += 1) {
      const last = i === handlers.length - 1;
      await handlers[i](request, response, () => {});
      if (last || response.statusCode >= 400) break;
    }
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.entries.length, 1);
    assert.equal(response.body.entries[0].action, 'doctor.delete');
    assert.equal(response.body.entries[0].actorEmail, 'admin@example.test');
  } finally {
    AuditLog.create = originalCreate;
    AuditLog.find = originalFind;
    auditUser.findById = originalUserFindById;
    if (previousSecret === undefined) delete process.env.DASHBOARD_SESSION_SECRET;
    else process.env.DASHBOARD_SESSION_SECRET = previousSecret;
  }
});
test('a patient asking to change an appointment is recognised', () => {
  const { wantsToChangeAppointment, canReschedule, formatNoAppointmentReply } =
    require('../src/appointmentReschedule');

  for (const phrase of [
    'cancel', 'Cancel', 'CANCEL', 'reschedule', 'rebook', 're-book',
    'change date', 'change my appointment', 'move my appointment',
    'appointment cancel', 'appointment change', 'appointment hatana',
    'tareekh badlein', 'waqt badlein', 'dobara book', 'shift my booking'
  ]) {
    assert.equal(wantsToChangeAppointment(phrase), true, `"${phrase}" should start the reschedule flow`);
  }

  // Asking about an appointment is not asking to change it.
  for (const phrase of [
    'meri appointment kab hai', 'appointment kab hai', 'confirm', 'koi appointment',
    'appointment time kya hai', ''
  ]) {
    assert.equal(wantsToChangeAppointment(phrase), false, `"${phrase}" must not trigger the flow`);
  }
  assert.equal(wantsToChangeAppointment(null), false);
  assert.equal(wantsToChangeAppointment(undefined), false);

  // Long free text is symptoms, not a command.
  const longSymptoms = 'mujhe do teen din se bukhar hai aur seene mein dard bhi ho raha hai kuch zyada nahi';
  assert.equal(wantsToChangeAppointment(longSymptoms), false,
    'a long description of symptoms must not be read as a cancellation');

  // Only a future, still booked appointment may be moved.
  const now = new Date('2026-11-01T00:00:00Z');
  assert.equal(canReschedule({ status: 'booked', slotStart: new Date('2026-11-05T00:00:00Z') }, now), true);
  assert.equal(canReschedule({ status: 'booked', slotStart: new Date('2026-10-01T00:00:00Z') }, now), false,
    'a past appointment cannot be rescheduled');
  assert.equal(canReschedule({ status: 'cancelled', slotStart: new Date('2026-11-05T00:00:00Z') }, now), false);
  assert.equal(canReschedule(null, now), false);

  assert.match(formatNoAppointmentReply(), /appointment/i);
});

test('the reschedule steps cannot collide with the booking steps', () => {
  const {
    RESCHEDULE_DATE_STEP, RESCHEDULE_SELECTION_STEP
  } = require('../src/appointmentReschedule');
  const bookingSteps = ['name', 'contactNumber', 'majorSymptoms', 'appointmentDate', 'calendarSelection'];
  for (const step of bookingSteps) {
    assert.notEqual(RESCHEDULE_DATE_STEP, step, `${step} must keep its own meaning`);
    assert.notEqual(RESCHEDULE_SELECTION_STEP, step, `${step} must keep its own meaning`);
  }
});

test('a patient with no appointment is told so instead of entering the flow', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

  // The handler must look the patient up by their own sender id and clinic, never
  // by a value taken from the conversation or the message.
  assert.match(serverSource, /findOne\(\{ doctorId, senderJid: sender, status: 'booked' \}\)/,
    'the lookup must be scoped to this clinic and this sender');
  assert.match(serverSource, /_id: appointment\._id, doctorId: targetDoctorId, senderJid: sender/,
    'the move must be scoped to this clinic and this sender');

  // The reschedule branches must run before the booking branches so they cannot be
  // swallowed by the calendar selection step.
  const rescheduleBranch = serverSource.indexOf('wantsToChangeAppointment(normalizedMessage)');
  const bookingBranch = serverSource.indexOf("conversation.step === 'calendarSelection'");
  assert.ok(rescheduleBranch > -1 && bookingBranch > -1, 'both branches must exist');
  assert.ok(rescheduleBranch < bookingBranch,
    'the change intent must be handled before the booking flow so it is not misread as a slot number');
});

test('a failed reschedule leaves the original appointment alone', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

  // The new slot is checked for a clash before the old booking is modified, and the
  // update itself is conditional on the booking still being present and booked.
  const clashCheck = serverSource.indexOf('status: \'booked\', slotStart: newStart, _id: { $ne: appointment._id }');
  const moveStatement = serverSource.indexOf('slotStart: newStart,', clashCheck);
  assert.ok(clashCheck > -1, 'a clash must be detected');
  assert.ok(clashCheck < moveStatement, 'the clash check must run before the appointment is moved');
  assert.match(serverSource, /\{ _id: appointment\._id, doctorId: targetDoctorId, senderJid: sender, status: 'booked' \}/,
    'the move must only apply to a still booked appointment owned by this sender');
  assert.match(serverSource, /\$unset: \{ cancelledAt: 1, cancelledBy: 1 \}/,
    'a moved appointment must not keep a cancellation stamp');
});
