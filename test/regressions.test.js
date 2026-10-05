const assert = require('node:assert/strict');
const test = require('node:test');
const ExcelJS = require('exceljs');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { getLocalDayBounds, parseRequestedDate } = require('../src/dateParser');
const { getReligiousHoliday, isClinicOpenOnDate, normalizeOffDays, normalizeWorkingDays } = require('../src/clinicSchedule');
const { enqueueInboundMessage, drainInboundQueue, getReceivedAt, messageRetentionMs } = require('../src/messageQueue');
const { syncReligiousHolidayEvents } = require('../src/religiousCalendar');
const { getVoiceFileExtension, translateVoiceMessageToEnglish } = require('../src/voiceTranscription');
const { createGoogleOAuthState, createSessionToken, mountDashboard, verifyGoogleOAuthState, verifySessionToken } = require('../src/dashboard');
const { generateAppointmentsWorkbook } = require('../src/excelGenerator');
const { getCalendarErrorDetails } = require('../src/calendarErrors');
const { getWelcomeMessage } = require('../src/greetings');
const { hashPassword, verifyPassword } = require('../src/passwords');
const { decryptJson, encryptJson, hasValidEncryptionKey } = require('../src/secretBox');
const { buildSystemInstruction } = require('../src/gemini');
const { startDailyReport } = require('../src/cronJobs');

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
    }
  );
  assert.equal(request.url, 'https://api.openai.com/v1/audio/translations');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.equal(transcript, 'Please book an appointment tomorrow.');
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
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); }
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

test('daily report cron remains scheduled when SMTP is not configured', () => {
  const settingNames = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'DAILY_REPORT_CRON'];
  const previousSettings = Object.fromEntries(settingNames.map((name) => [name, process.env[name]]));
  const originalSchedule = cron.schedule;
  let scheduledJob;
  for (const name of settingNames) process.env[name] = '';
  cron.schedule = (expression, callback, options) => {
    scheduledJob = { expression, callback, options };
    return { stop() {} };
  };

  try {
    const task = startDailyReport({ doctorId: 'report-test-clinic', email: 'doctor@example.test' });
    assert.ok(task);
    assert.ok(scheduledJob);
    assert.equal(scheduledJob.expression, '0 0 * * *');
    assert.equal(scheduledJob.options.timezone, 'Asia/Karachi');
    assert.equal(scheduledJob.options.noOverlap, true);
  } finally {
    cron.schedule = originalSchedule;
    for (const name of settingNames) {
      if (previousSettings[name] === undefined) delete process.env[name];
      else process.env[name] = previousSettings[name];
    }
  }
});

test('midnight report filters booked appointments in the next 24 hours per doctor', async () => {
  const settingNames = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'DAILY_REPORT_CRON'];
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
    schedule: cron.schedule
  };
  let scheduledJob;
  let appointmentFilter;
  let completion;
  for (const name of settingNames) process.env[name] = '';
  process.env.DAILY_REPORT_CRON = '17 23 * * *';
  cron.schedule = (expression, callback, options) => {
    scheduledJob = { expression, callback, options };
    return { stop() {} };
  };
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
    startDailyReport({ doctorId: 'report-tenant' });
    assert.equal(scheduledJob.expression, '0 0 * * *');
    await scheduledJob.callback();
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
    cron.schedule = originalMethods.schedule;
    for (const name of settingNames) {
      if (previousSettings[name] === undefined) delete process.env[name];
      else process.env[name] = previousSettings[name];
    }
  }
});

test('midnight report emails an Excel attachment to the current doctor profile', async () => {
  const settingNames = [
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS', 'SMTP_USER',
    'SMTP_PASS', 'EMAIL_FROM', 'DAILY_REPORT_CRON'
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
    createTransport: nodemailer.createTransport,
    schedule: cron.schedule
  };
  let scheduledJob;
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
  cron.schedule = (expression, callback, options) => {
    scheduledJob = { expression, callback, options };
    return { stop() {} };
  };
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
    startDailyReport({ doctorId: 'email-tenant', email: 'stale@example.test' });
    assert.equal(scheduledJob.expression, '0 0 * * *');
    await scheduledJob.callback();
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
    cron.schedule = originalMethods.schedule;
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
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); }
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
    assert.deepEqual(response.body, qrState);
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
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); }
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
        facilitiesList: ['OPD', 'Imaging'],
        servicesList: ['Vaccination'],
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
    assert.deepEqual(savedUpdate.$set.workingDays, [1, 6]);
    assert.deepEqual(savedUpdate.$set.offDays, ['2026-12-25']);
    assert.deepEqual(savedUpdate.$set.servicesList, ['Vaccination']);
    assert.equal(savedUpdate.$set.religion, 'Muslim');

    response = makeResponse();
    await connectAuth(request, response, () => {});
    await connectHandler(request, response);
    assert.equal(response.statusCode, 202);
    assert.equal(pairingStarted, true);
  } finally {
    DashboardUser.findById = originalMethods.dashboardFindById;
    Doctor.findOne = originalMethods.doctorFindOne;
    Doctor.findOneAndUpdate = originalMethods.doctorFindOneAndUpdate;
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
    consultationDetails: 'By appointment only.'
  };
  assert.match(getWelcomeMessage('Hi', doctor), /^Hello!/);
  assert.match(getWelcomeMessage('Salam', doctor), /^Walaikum Assalam!/);
  assert.match(getWelcomeMessage('I need an appointment', doctor), /^Ji farmaiye!/);
  assert.match(getWelcomeMessage('Hi', doctor), /1\. Outpatient[\s\S]*2\. Imaging/);
  assert.match(getWelcomeMessage('Hi', doctor), /Vaccination/);
  assert.match(getWelcomeMessage('Hi', doctor), /By appointment only/);
  assert.doesNotMatch(getWelcomeMessage('Hi', doctor), /Dr\. Ahmad|City Care Clinic|General OPD/);
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
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); }
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
    'GOOGLE_REDIRECT_URI', 'DOCTOR_CONFIG_ENCRYPTION_KEY'
  ];
  const previousEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  const DashboardUser = mongoose.models.DashboardUser;
  const Doctor = mongoose.models.Doctor;
  const originalMethods = {
    dashboardFindById: DashboardUser.findById,
    dashboardUpdateOne: DashboardUser.updateOne,
    dashboardFindOneAndUpdate: DashboardUser.findOneAndUpdate,
    doctorFindOne: Doctor.findOne,
    doctorUpdateOne: Doctor.updateOne,
    OAuth2: google.auth.OAuth2
  };
  const user = { _id: 'oauth-doctor-user', role: 'DOCTOR', doctorId: 'clinic-alpha', isActive: true };
  const encryptionEnvironment = { DOCTOR_CONFIG_ENCRYPTION_KEY: 'c'.repeat(64) };
  let nonce;
  let oauthOptions;
  let doctorUpdate;
  let oauthConstructorArgs;
  process.env.DASHBOARD_SESSION_SECRET = 'oauth-dashboard-session-secret-long-enough';
  process.env.GOOGLE_CLIENT_ID = 'shared-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'shared-client-secret';
  process.env.GOOGLE_REDIRECT_URI = 'https://clinic.example/api/auth/google/callback';
  process.env.DOCTOR_CONFIG_ENCRYPTION_KEY = encryptionEnvironment.DOCTOR_CONFIG_ENCRYPTION_KEY;
  DashboardUser.findById = () => ({ lean: async () => user });
  DashboardUser.updateOne = async (_filter, update) => {
    nonce = update.$set.googleOAuthNonce;
    return { matchedCount: 1 };
  };
  DashboardUser.findOneAndUpdate = (filter) => ({
    lean: async () => filter.googleOAuthNonce === nonce ? user : null
  });
  Doctor.findOne = () => ({ lean: async () => ({ doctorId: user.doctorId, isActive: true }) });
  Doctor.updateOne = async (filter, update) => {
    doctorUpdate = { filter, update };
    return { matchedCount: 1 };
  };
  google.auth.OAuth2 = class MockOAuth2 {
    constructor(...args) { oauthConstructorArgs = args; }
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
      patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); }
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

    request.query = { code: 'authorization-code', state: oauthOptions.state };
    response.locals = {};
    const [callbackAuth, callbackHandler] = routes.get('GET /api/auth/google/callback');
    await callbackAuth(request, response, () => {});
    await callbackHandler(request, response);
    assert.equal(response.redirectUrl, '/dashboard?calendar=connected');
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
    for (const name of environmentNames) {
      if (previousEnvironment[name] === undefined) delete process.env[name];
      else process.env[name] = previousEnvironment[name];
    }
  }
});