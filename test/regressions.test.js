const assert = require('node:assert/strict');
const test = require('node:test');
const ExcelJS = require('exceljs');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const cron = require('node-cron');
const { getLocalDayBounds, parseRequestedDate } = require('../src/dateParser');
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

test('Gemini extraction instructions require schema-only output', () => {
  const instruction = buildSystemInstruction({
    doctorName: 'Dr. Example',
    clinicName: 'Example Clinic',
    facilitiesList: ['OPD', 'Imaging'],
    welcomeMessage: 'Welcome to Example Clinic'
  });
  assert.match(instruction, /Return only valid JSON matching the supplied responseSchema/);
  assert.match(instruction, /application constructs all patient-facing replies/);
  assert.match(instruction, /Dr\. Example/);
  assert.match(instruction, /OPD, Imaging/);
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
  assert.ok(Conversation.schema.indexes().some(([keys, options]) =>
    keys.doctorId && keys.senderJid && options.unique
  ));
  assert.ok(Appointment.schema.indexes().some(([keys, options]) =>
    keys.doctorId && keys.slotKey && options.unique
  ));
  assert.ok(DailyReportRun.schema.indexes().some(([keys, options]) =>
    keys.doctorId && keys.dateKey && options.unique
  ));
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
  const settingNames = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'];
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

test('Excel report contains the requested patient columns and data', async () => {
  const workbookBuffer = await generateAppointmentsWorkbook([{
    details: {
      name: 'Sample Patient',
      contactNumber: '+923001234567',
      majorSymptoms: 'Sample symptom'
    },
    slotStart: new Date('2026-10-03T05:00:00Z'),
    slotEnd: new Date('2026-10-03T05:30:00Z')
  }], 'Asia/Karachi');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(workbookBuffer);
  const sheet = workbook.worksheets[0];
  assert.deepEqual(sheet.getRow(1).values.slice(1), [
    'Patient Name', 'WhatsApp Number', 'Symptoms', 'Appointment Slot'
  ]);
  assert.equal(sheet.getRow(2).getCell(1).value, 'Sample Patient');
  assert.equal(sheet.getRow(2).getCell(3).value, 'Sample symptom');
});

test('first-message greetings are deterministic and include ordered facilities', () => {
  const doctor = {
    doctorName: 'Dr. Example',
    clinicName: 'Example Clinic',
    welcomeMessage: 'Welcome to Example Clinic',
    facilitiesList: ['Outpatient', 'Imaging']
  };
  assert.match(getWelcomeMessage('Hi', doctor), /^Hello!/);
  assert.match(getWelcomeMessage('Salam', doctor), /^Walaikum Assalam!/);
  assert.match(getWelcomeMessage('I need an appointment', doctor), /^Ji farmaiye!/);
  assert.match(getWelcomeMessage('Hi', doctor), /1\. Outpatient[\s\S]*2\. Imaging/);
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