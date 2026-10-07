const crypto = require('node:crypto');
const path = require('node:path');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const { getLocalDateParts, getLocalDayBounds } = require('./dateParser');
const { DashboardUser, DailyReportRun, Doctor, InboundMessage, ServiceLog, consumeDashboardLoginAttempt } = require('./models');
const { hashPassword, verifyPassword } = require('./passwords');
const { encryptJson, hasValidEncryptionKey } = require('./secretBox');
const { normalizeOffDays, normalizeWorkingDays } = require('./clinicSchedule');
const { getReligiousHolidays } = require('./clinicSchedule');
const { isValidRupeeAmount, normalizeFacilityPricing } = require('./facilityPricing');
const { normalizeClinicTimingInput, resolveClinicTiming } = require('./clinicTiming');
const { verifyDoctorCalendarAccess } = require('./calendarAccess');

const cookieName = 'doctorbot_dashboard';
const sessionDurationSeconds = 8 * 60 * 60;

function getDashboardSecret() {
  const sessionSecret = process.env.DASHBOARD_SESSION_SECRET;
  if (sessionSecret && sessionSecret.length >= 32) return sessionSecret;
  const legacySecret = process.env.DASHBOARD_COOKIE_SECRET;
  return legacySecret && legacySecret.length >= 32 ? legacySecret : null;
}

function constantTimeEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createSessionToken(user, secret, expiresAt) {
  const payload = Buffer.from(JSON.stringify({
    userId: String(user._id),
    role: user.role,
    doctorId: user.doctorId || null,
    expiresAt
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function getSessionClaims(token, secret) {
  if (!token || !secret) return null;
  const separator = token.lastIndexOf('.');
  if (separator < 1) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!constantTimeEquals(signature, expectedSignature)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!claims.userId || !['SUPERADMIN', 'DOCTOR'].includes(claims.role) ||
      !Number.isInteger(claims.expiresAt) || claims.expiresAt <= Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

function verifySessionToken(token, secret, expected = {}) {
  const claims = getSessionClaims(token, secret);
  if (!claims) return false;
  return Object.entries(expected).every(([key, value]) => claims[key] === value);
}

function createGoogleOAuthState(userId, doctorId, nonce, expiresAt, secret) {
  const payload = Buffer.from(JSON.stringify({ userId, doctorId, nonce, expiresAt })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyGoogleOAuthState(state, secret) {
  const separator = String(state || '').lastIndexOf('.');
  if (separator < 1 || !secret) return null;
  const payload = state.slice(0, separator);
  const signature = state.slice(separator + 1);
  const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!constantTimeEquals(signature, expectedSignature)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!claims.userId || !claims.doctorId || !claims.nonce ||
      !Number.isInteger(claims.expiresAt) || claims.expiresAt <= Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

function getCookie(request, name) {
  const prefix = `${name}=`;
  const value = (request.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return value ? value.slice(prefix.length) : '';
}

async function requireDashboardAuth(request, response, next) {
  const secret = getDashboardSecret();
  const claims = getSessionClaims(getCookie(request, cookieName), secret);
  if (!claims) {
    return response.status(401).json({ error: 'Authentication required' });
  }

  try {
    const user = await DashboardUser.findById(claims.userId).lean();
    if (!user || !user.isActive || user.role !== claims.role || (user.doctorId || null) !== claims.doctorId) {
      return response.status(401).json({ error: 'Authentication required' });
    }
    if (user.role === 'DOCTOR') {
      const doctor = await Doctor.findOne({ doctorId: user.doctorId, isActive: true }).lean();
      if (!doctor) return response.status(403).json({ error: 'Doctor account is inactive' });
      response.locals.doctor = doctor;
    }
    response.locals.dashboardUser = user;
    next();
  } catch (error) {
    console.error(`Dashboard authorization failed (${error?.name || 'Error'})`);
    response.status(503).json({ error: 'Dashboard authentication is temporarily unavailable' });
  }
}

function requireSuperadmin(request, response, next) {
  if (response.locals.dashboardUser?.role !== 'SUPERADMIN') {
    return response.status(403).json({ error: 'Superadmin access required' });
  }
  next();
}

function isValidDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function isValidDoctorSlug(value) {
  return /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(String(value || ''));
}

function clampInteger(value, { min, max, fallback }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// Search terms reach a Mongo regex, so user input must never be treated as a pattern.
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskDatabaseUri(uri) {
  if (typeof uri !== 'string' || !uri.includes('@')) return null;
  const [, rest] = uri.split('@');
  const host = rest.split('/')[0];
  return `${host.split(':')[0]}`;
}

function formatClinicDateKey(dateParts) {
  return `${dateParts.year}-${String(dateParts.month).padStart(2, '0')}-${String(dateParts.day).padStart(2, '0')}`;
}

function validateGoogleRedirectUriValue(value) {
  let redirectUri;
  try {
    redirectUri = new URL(value);
  } catch {
    return 'GOOGLE_REDIRECT_URI must be an absolute URL.';
  }
  const isLocalHttp = redirectUri.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(redirectUri.hostname);
  if ((redirectUri.protocol !== 'https:' && !isLocalHttp) ||
    redirectUri.pathname !== '/api/auth/google/callback' || redirectUri.search || redirectUri.hash ||
    redirectUri.username || redirectUri.password) {
    return 'GOOGLE_REDIRECT_URI must use HTTPS and end exactly with /api/auth/google/callback (HTTP is allowed only on localhost).';
  }
  return null;
}

function getGoogleCalendarConfigurationError(environment = process.env) {
  if (!environment.GOOGLE_CLIENT_ID) return 'GOOGLE_CLIENT_ID is missing.';
  if (!environment.GOOGLE_CLIENT_SECRET) return 'GOOGLE_CLIENT_SECRET is missing.';
  if (environment.GOOGLE_REDIRECT_URI) {
    const redirectError = validateGoogleRedirectUriValue(environment.GOOGLE_REDIRECT_URI);
    if (redirectError) return redirectError;
  }
  if (!hasValidEncryptionKey(environment)) return 'DOCTOR_CONFIG_ENCRYPTION_KEY must encode exactly 32 bytes.';
  return null;
}

// Behind a TLS-terminating proxy (Render, Cloudflare, nginx) the app receives a
// plain HTTP hop, so request.protocol reports "http" even though the browser used
// HTTPS. X-Forwarded-Proto is authoritative in that setup, so it must win over
// request.protocol or Google will reject an http:// redirect URI.
function getRequestProtocol(request) {
  const forwardedProto = String(request?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (forwardedProto === 'https' || forwardedProto === 'http') return forwardedProto;
  if (request?.secure === true || request?.socket?.encrypted === true) return 'https';
  const expressProtocol = String(request?.protocol || '').toLowerCase();
  if (expressProtocol === 'https' || expressProtocol === 'http') return expressProtocol;
  return 'http';
}

// The redirect URI sent to Google must be byte-identical in the auth request, the
// token exchange, and the Google Cloud Console "Authorized redirect URIs" list.
// GOOGLE_REDIRECT_URI wins when configured; otherwise the exact URI is derived from
// the incoming request so local and live onboarding can never drift apart.
function resolveGoogleRedirectUri(request, environment = process.env) {
  if (environment.GOOGLE_REDIRECT_URI) {
    const error = validateGoogleRedirectUriValue(environment.GOOGLE_REDIRECT_URI);
    return { redirectUri: error ? null : environment.GOOGLE_REDIRECT_URI, error };
  }

  const host = request?.get?.('host') || request?.headers?.host || '';
  const protocol = getRequestProtocol(request);
  if (!host || !/^[^\s/@]+$/.test(host)) {
    return { redirectUri: null, error: 'Set GOOGLE_REDIRECT_URI to this server\u2019s public /api/auth/google/callback URL.' };
  }
  const derived = `${protocol}://${host}/api/auth/google/callback`;
  const error = validateGoogleRedirectUriValue(derived);
  if (error) {
    return {
      redirectUri: null,
      error: `${error} Derived "${derived}" from this request; set GOOGLE_REDIRECT_URI to the public HTTPS callback URL and register the same value in Google Cloud Console.`
    };
  }
  return { redirectUri: derived, error: null };
}

// Absolute public origin of this deployment, used for the legal-page URLs that the
// Google OAuth consent screen requires.
function resolvePublicBaseUrl(request) {
  const host = request?.get?.('host') || request?.headers?.host || '';
  const protocol = getRequestProtocol(request);
  if (!host || !/^[^\s/@]+$/.test(host)) return '';
  return `${protocol}://${host}`;
}

function getGoogleCalendarOAuthStatus(request, environment = process.env) {
  const configurationError = getGoogleCalendarConfigurationError(environment);
  const { redirectUri, error: redirectError } = resolveGoogleRedirectUri(request, environment);
  const error = configurationError || redirectError;
  return {
    available: !error,
    redirectUri,
    error: error || null
  };
}

function normalizeDoctorSettings(body = {}) {
  const {
    doctorName, clinicName, consultationDetails, workingDays, offDays, religion,
    basicCheckupFee, facilityPricing, welcomeMessage
  } = body;
  const timingPatch = normalizeClinicTimingInput(body);
  const normalizedWorkingDays = normalizeWorkingDays(workingDays);
  const normalizedOffDays = normalizeOffDays(offDays);
  const requestedHolidayOpenDays = normalizeOffDays(body.religiousHolidayOpenDays || []);
  const normalizedPricing = normalizeFacilityPricing(facilityPricing);

  if (typeof doctorName !== 'string' || !doctorName.trim() || doctorName.length > 120) {
    return { error: 'Enter a doctor name of 120 characters or fewer.' };
  }
  if (typeof clinicName !== 'string' || !clinicName.trim() || clinicName.length > 160) {
    return { error: 'Enter a clinic name of 160 characters or fewer.' };
  }
  if (!normalizedPricing || !normalizedPricing.length) {
    return { error: 'Add at least one facility or treatment with a price.' };
  }
  if (!normalizedWorkingDays) return { error: 'Select at least one working day.' };
  if (!normalizedOffDays) return { error: 'One or more clinic off-days is not a valid date.' };
  if (!requestedHolidayOpenDays) return { error: 'One or more religious holiday dates is not valid.' };
  if (!timingPatch) return { error: 'Check the clinic timings: closing time must be later than opening time, and bookings 1 to 30 days ahead.' };
  if (!isValidRupeeAmount(basicCheckupFee)) return { error: 'Enter the basic checkup fee as a rupee amount of 0 or more.' };
  if (typeof consultationDetails !== 'string' || !consultationDetails.trim() || consultationDetails.length > 2000) {
    return { error: 'Enter consultation details of 2000 characters or fewer.' };
  }
  if (!['Christian', 'Muslim', 'Hindu', 'Other'].includes(religion)) {
    return { error: 'Choose a religion so religious holidays can be calculated.' };
  }
  if (typeof welcomeMessage !== 'string' || welcomeMessage.length > 1000) {
    return { error: 'Keep the welcome message to 1000 characters or fewer.' };
  }

  const facilitiesList = normalizedPricing.filter(({ category }) => category === 'facility').map(({ name }) => name);
  const servicesList = normalizedPricing.filter(({ category }) => category === 'service').map(({ name }) => name);

  // A holiday override only means something for the selected religion. When the
  // religion changes, stale overrides are dropped rather than blocking the save,
  // which previously locked a clinic out of saving entirely.
  const currentYear = getLocalDateParts(new Date(), 'Asia/Karachi').year;
  const holidayYears = new Set([currentYear, currentYear + 1,
    ...requestedHolidayOpenDays.map((date) => Number(date.slice(0, 4)))
  ]);
  const knownHolidayDates = new Set([...holidayYears]
    .flatMap((year) => getReligiousHolidays(religion, year).map(({ date }) => date)));
  const religiousHolidayOpenDays = requestedHolidayOpenDays.filter((date) => knownHolidayDates.has(date));
  const droppedHolidayOverrides = requestedHolidayOpenDays.length - religiousHolidayOpenDays.length;

  return {
    error: null,
    droppedHolidayOverrides,
    settings: {
      doctorName: doctorName.trim(),
      clinicName: clinicName.trim(),
      facilitiesList,
      servicesList,
      facilityPricing: normalizedPricing,
      basicCheckupFee,
      consultationDetails: consultationDetails.trim(),
      workingDays: normalizedWorkingDays,
      offDays: normalizedOffDays,
      religiousHolidayOpenDays,
      religion,
      welcomeMessage: welcomeMessage.trim(),
      ...timingPatch,
      setupComplete: true,
      updatedAt: new Date()
    }
  };
}

// Superadmin edits may target any subset of a doctor's configuration, before or
// after the doctor completes their own setup. Only provided fields are validated
// and applied; setupComplete is recomputed from the merged profile so a tenant is
// never half-configured without the record saying so.
function normalizeAdminDoctorPatch(body = {}, existingDoctor = {}) {
  const patch = {};

  if (body.doctorName !== undefined) {
    if (typeof body.doctorName !== 'string' || !body.doctorName.trim() || body.doctorName.length > 120) return null;
    patch.doctorName = body.doctorName.trim();
  }
  if (body.clinicName !== undefined) {
    if (typeof body.clinicName !== 'string' || !body.clinicName.trim() || body.clinicName.length > 160) return null;
    patch.clinicName = body.clinicName.trim();
  }
  if (body.religion !== undefined) {
    if (!['Christian', 'Muslim', 'Hindu', 'Other'].includes(body.religion)) return null;
    patch.religion = body.religion;
  }
  if (body.basicCheckupFee !== undefined) {
    if (!isValidRupeeAmount(body.basicCheckupFee)) return null;
    patch.basicCheckupFee = body.basicCheckupFee;
  }
  if (body.facilityPricing !== undefined) {
    const normalizedPricing = normalizeFacilityPricing(body.facilityPricing);
    if (!normalizedPricing) return null;
    patch.facilityPricing = normalizedPricing;
    patch.facilitiesList = normalizedPricing.filter(({ category }) => category === 'facility').map(({ name }) => name);
    patch.servicesList = normalizedPricing.filter(({ category }) => category === 'service').map(({ name }) => name);
  }
  if (body.consultationDetails !== undefined) {
    if (typeof body.consultationDetails !== 'string' || body.consultationDetails.length > 2000) return null;
    patch.consultationDetails = body.consultationDetails.trim();
  }
  if (body.workingDays !== undefined) {
    const normalizedWorkingDays = normalizeWorkingDays(body.workingDays);
    if (!normalizedWorkingDays) return null;
    patch.workingDays = normalizedWorkingDays;
  }
  if (body.officeStartHour !== undefined || body.officeEndHour !== undefined ||
    body.appointmentDurationMinutes !== undefined || body.appointmentLookaheadDays !== undefined) {
    const timingPatch = normalizeClinicTimingInput({
      officeStartHour: body.officeStartHour,
      officeEndHour: body.officeEndHour,
      appointmentDurationMinutes: body.appointmentDurationMinutes,
      appointmentLookaheadDays: body.appointmentLookaheadDays
    });
    if (!timingPatch) return null;
    Object.assign(patch, timingPatch);
  }
  if (body.offDays !== undefined) {
    const normalizedOffDays = normalizeOffDays(body.offDays);
    if (!normalizedOffDays) return null;
    patch.offDays = normalizedOffDays;
  }
  if (body.welcomeMessage !== undefined) {
    if (typeof body.welcomeMessage !== 'string' || body.welcomeMessage.length > 1000) return null;
    patch.welcomeMessage = body.welcomeMessage.trim();
  }
  if (body.religiousHolidayOpenDays !== undefined) {
    const religiousHolidayOpenDays = normalizeOffDays(body.religiousHolidayOpenDays);
    if (!religiousHolidayOpenDays) return null;
    const mergedReligion = patch.religion || existingDoctor.religion || 'Other';
    const currentYear = getLocalDateParts(new Date(), 'Asia/Karachi').year;
    const holidayYears = new Set([currentYear, currentYear + 1,
      ...religiousHolidayOpenDays.map((date) => Number(date.slice(0, 4)))
    ]);
    const knownHolidayDates = new Set([...holidayYears]
      .flatMap((year) => getReligiousHolidays(mergedReligion, year).map(({ date }) => date)));
    if (religiousHolidayOpenDays.some((date) => !knownHolidayDates.has(date))) return null;
    patch.religiousHolidayOpenDays = religiousHolidayOpenDays;
  }

  patch.updatedAt = new Date();
  const merged = { ...existingDoctor, ...patch };
  patch.setupComplete = Boolean(normalizeDoctorSettings({
    doctorName: merged.doctorName,
    clinicName: merged.clinicName,
    religion: merged.religion,
    basicCheckupFee: merged.basicCheckupFee,
    facilityPricing: merged.facilityPricing,
    consultationDetails: merged.consultationDetails,
    workingDays: merged.workingDays,
    offDays: merged.offDays,
    religiousHolidayOpenDays: merged.religiousHolidayOpenDays || [],
    welcomeMessage: merged.welcomeMessage || '',
    officeStartHour: merged.officeStartHour,
    officeEndHour: merged.officeEndHour,
    appointmentDurationMinutes: merged.appointmentDurationMinutes,
    appointmentLookaheadDays: merged.appointmentLookaheadDays
  }).error === null);
  return patch;
}

function mountDashboard(app, Appointment, timeZone, clinicId, whatsappConnection = {}) {
  app.use('/api/dashboard', (_request, response, next) => {
    response.set('Cache-Control', 'no-store, private');
    next();
  });

  app.get('/dashboard', (_request, response) => {
    response.sendFile(path.join(__dirname, 'dashboard.html'));
  });

  app.post('/api/dashboard/login', async (request, response) => {
    const { email, password } = request.body || {};
    const secret = getDashboardSecret();

    if (!secret || secret.length < 32) {
      return response.status(503).json({ error: 'Dashboard authentication is not configured' });
    }

    let attemptLimit;
    try {
      attemptLimit = await consumeDashboardLoginAttempt(request.ip, clinicId || 'global');
    } catch (error) {
      console.error(`Dashboard login limiter unavailable (${error?.name || 'Error'})`);
      return response.status(503).json({ error: 'Dashboard login is temporarily unavailable' });
    }
    if (!attemptLimit.allowed) {
      response.set('Retry-After', String(attemptLimit.retryAfterSeconds));
      return response.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }

    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    let user;
    let doctorIsActive = false;
    try {
      user = await DashboardUser.findOne({ email: normalizedEmail }).lean();
      if (user?.role === 'DOCTOR') {
        doctorIsActive = Boolean(await Doctor.exists({ doctorId: user.doctorId, isActive: true }));
      }
    } catch (error) {
      console.error(`Dashboard login lookup failed (${error?.name || 'Error'})`);
      return response.status(503).json({ error: 'Dashboard login is temporarily unavailable' });
    }

    if (!user || !user.isActive || !await verifyPassword(password, user.passwordHash)) {
      return response.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.role === 'DOCTOR' && !doctorIsActive) {
      return response.status(403).json({ error: 'Doctor account is inactive' });
    }

    const token = createSessionToken(user, secret, Date.now() + sessionDurationSeconds * 1000);
    response.cookie(cookieName, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: sessionDurationSeconds * 1000,
      path: '/'
    });
    response.json({ authenticated: true });
  });

  app.get('/api/auth/google', requireDashboardAuth, async (request, response) => {
    const user = response.locals.dashboardUser;
    const secret = getDashboardSecret();
    if (user.role !== 'DOCTOR' || !user.doctorId) {
      return response.status(403).json({ error: 'Doctor access required' });
    }
    const oauthStatus = getGoogleCalendarOAuthStatus(request);
    if (!secret || !oauthStatus.available) {
      return response.status(503).json({ error: oauthStatus.error || 'Dashboard session signing secret is not configured.' });
    }

    try {
      const nonce = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await DashboardUser.updateOne(
        { _id: user._id, doctorId: user.doctorId, role: 'DOCTOR', isActive: true },
        { $set: { googleOAuthNonce: nonce, googleOAuthNonceExpiresAt: expiresAt } }
      );
      const state = createGoogleOAuthState(
        String(user._id),
        user.doctorId,
        nonce,
        expiresAt.getTime(),
        secret
      );
      const oauthClient = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        oauthStatus.redirectUri
      );
      response.redirect(oauthClient.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: true,
        // Deliberately NOT the full "calendar" scope: that is a Google RESTRICTED
        // scope, which blocks sign-in with "doesn't comply with Google's OAuth
        // policy" until the app completes verification. These two narrow scopes
        // cover every Calendar call this service makes (free/busy lookup, event
        // insert, event delete) and are only classified as sensitive.
        scope: [
          'https://www.googleapis.com/auth/calendar.freebusy',
          'https://www.googleapis.com/auth/calendar.events'
        ],
        state
      }));
    } catch (error) {
      console.error(`Google OAuth start failed (${error?.name || 'Error'})`);
      response.status(503).json({ error: 'Google Calendar connection could not be started' });
    }
  });

  app.get('/api/auth/google/callback', requireDashboardAuth, async (request, response) => {
    const user = response.locals.dashboardUser;
    if (user.role !== 'DOCTOR' || !user.doctorId) {
      return response.status(403).json({ error: 'Doctor access required' });
    }
    const oauthStatus = getGoogleCalendarOAuthStatus(request);
    if (request.query.error === 'redirect_uri_mismatch') {
      return response.status(400).send(
        `Google rejected the redirect URI. Register this exact value under Authorized redirect URIs in Google Cloud Console: ${oauthStatus.redirectUri || '(could not be derived — set GOOGLE_REDIRECT_URI)'}`
      );
    }
    if (request.query.error) return response.status(400).send('Google Calendar connection was cancelled.');
    if (!oauthStatus.available) {
      return response.status(503).send(`Google Calendar is not configured correctly: ${oauthStatus.error}`);
    }

    const state = verifyGoogleOAuthState(request.query.state, getDashboardSecret());
    if (!state || state.userId !== String(user._id) || state.doctorId !== user.doctorId ||
      typeof request.query.code !== 'string') {
      return response.status(400).send('Google Calendar authorization state is invalid or expired. Restart the connection from the dashboard.');
    }

    try {
      const consumedState = await DashboardUser.findOneAndUpdate(
        {
          _id: user._id,
          doctorId: user.doctorId,
          role: 'DOCTOR',
          isActive: true,
          googleOAuthNonce: state.nonce,
          googleOAuthNonceExpiresAt: { $gt: new Date() }
        },
        { $unset: { googleOAuthNonce: 1, googleOAuthNonceExpiresAt: 1 } },
        { new: true }
      ).lean();
      if (!consumedState) return response.status(400).send('Google Calendar authorization state has already been used or expired.');

      const oauthClient = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        oauthStatus.redirectUri
      );
      const { tokens } = await oauthClient.getToken(request.query.code);
      let refreshToken = tokens.refresh_token;
      if (!refreshToken) {
        const doctorWithCredentials = await Doctor.findOne({ doctorId: user.doctorId })
          .select('+googleCredentialsEncrypted').lean();
        if (doctorWithCredentials?.googleCredentialsEncrypted) {
          refreshToken = decryptJson(doctorWithCredentials.googleCredentialsEncrypted).refreshToken;
        }
      }
      if (!refreshToken) {
        return response.status(400).send('Google did not return a refresh token. Revoke previous app access and reconnect.');
      }

      const update = await Doctor.updateOne(
        { doctorId: user.doctorId, isActive: true },
        { $set: {
          googleCredentialsEncrypted: encryptJson({ refreshToken }),
          googleCalendarConnected: true
        } }
      );
      if (update.matchedCount !== 1) return response.status(403).send('Doctor account is inactive.');
      if (typeof whatsappConnection.syncReligiousHolidays === 'function') {
        try {
          await whatsappConnection.syncReligiousHolidays(user.doctorId);
        } catch {
          console.error('Religious holiday calendar sync failed (Error)');
        }
      }

      // Prove the stored token actually works so a broken connection is never
      // reported to the clinic as a successful one.
      const savedDoctor = await Doctor.findOne({ doctorId: user.doctorId, isActive: true })
        .select('+googleCredentialsEncrypted').lean();
      const verification = savedDoctor ? await verifyDoctorCalendarAccess({
        doctorProfile: savedDoctor,
        bootstrapDoctorId: clinicId,
        timeZone
      }) : { verified: false, code: 'CALENDAR_NOT_CONNECTED', message: 'Calendar could not be verified.' };
      if (!verification.verified) {
        console.error(`Google Calendar verification failed after connect [${verification.code}]`);
        return response.redirect(`/dashboard?calendar=failed&reason=${encodeURIComponent(verification.code || 'CALENDAR_VERIFICATION_FAILED')}`);
      }
      response.redirect('/dashboard?calendar=connected');
    } catch (error) {
      console.error(`Google OAuth callback failed (${error?.name || 'Error'})`);
      response.status(503).send('Google Calendar connection failed. Please retry from the dashboard.');
    }
  });

  app.post('/api/dashboard/logout', (_request, response) => {
    response.clearCookie(cookieName, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/'
    });
    response.status(204).end();
  });

  app.get('/api/dashboard/session', requireDashboardAuth, (_request, response) => {
    const user = response.locals.dashboardUser;
    response.json({
      authenticated: true,
      role: user.role,
      doctorId: user.doctorId || null,
      doctorName: response.locals.doctor?.doctorName || null,
      clinicName: response.locals.doctor?.clinicName || null
    });
  });

  app.get('/api/dashboard/appointments', requireDashboardAuth, async (request, response) => {
    const user = response.locals.dashboardUser;
    if (user.role !== 'DOCTOR') return response.status(403).json({ error: 'Doctor access required' });
    const today = getLocalDateParts(new Date(), timeZone);
    const dateKey = request.query.date || `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;
    if (!isValidDateKey(dateKey)) return response.status(400).json({ error: 'date must use YYYY-MM-DD format' });

    try {
      const [year, month, day] = dateKey.split('-').map(Number);
      const { start, end } = getLocalDayBounds({ year, month, day }, timeZone);
      const appointments = await Appointment.find({
        doctorId: user.doctorId,
        status: 'booked',
        slotStart: { $gte: start > new Date() ? start : new Date(), $lt: end },
      }).sort({ slotStart: 1 }).lean();
      response.json({
        date: dateKey,
        timeZone,
        appointments: appointments.map(({ details, slotStart, slotEnd }) => ({
          patientName: details.name,
          whatsAppNumber: details.contactNumber,
          symptoms: details.majorSymptoms,
          slotStart,
          slotEnd
        }))
      });
    } catch (error) {
      console.error(`Dashboard appointments failed (${error?.name || 'Error'})`);
      response.status(503).json({ error: 'Appointments are temporarily unavailable' });
    }
  });

  app.get('/api/dashboard/settings', requireDashboardAuth, (request, response) => {
    const doctor = response.locals.doctor;
    if (!doctor) return response.status(403).json({ error: 'Doctor access required' });
    const previewReligion = ['Christian', 'Muslim', 'Hindu', 'Other'].includes(request.query?.religion)
      ? request.query.religion
      : doctor.religion || 'Other';
    const currentDate = getLocalDateParts(new Date(), timeZone);
    const currentDateKey = formatClinicDateKey(currentDate);
    const oauthStatus = getGoogleCalendarOAuthStatus(request);
    response.json({
      doctorId: doctor.doctorId,
      doctorName: doctor.doctorName,
      clinicName: doctor.clinicName,
      email: doctor.email,
      facilitiesList: doctor.facilitiesList,
      basicCheckupFee: doctor.basicCheckupFee ?? null,
      facilityPricing: doctor.facilityPricing || [],
      servicesList: doctor.servicesList || [],
      consultationDetails: doctor.consultationDetails || '',
      workingDays: doctor.workingDays || [1, 2, 3, 4, 5],
      offDays: doctor.offDays || [],
      religiousHolidayOpenDays: doctor.religiousHolidayOpenDays || [],
      ...resolveClinicTiming(doctor),
      religiousHolidays: [...new Set([currentDate.year, currentDate.year + 1])]
        .flatMap((year) => getReligiousHolidays(previewReligion, year))
        .filter(({ date }) => date >= currentDateKey),
      setupComplete: doctor.setupComplete === true,
      religion: doctor.religion || 'Other',
      welcomeMessage: doctor.welcomeMessage,
      googleCalendarConnected: doctor.googleCalendarConnected,
      calendarOAuthAvailable: oauthStatus.available,
      calendarOAuthError: oauthStatus.error,
      googleRedirectUri: oauthStatus.redirectUri,
      googleCalendarId: doctor.googleCalendarId,
      privacyPolicyUrl: `${resolvePublicBaseUrl(request)}/privacy-policy`,
      termsOfServiceUrl: `${resolvePublicBaseUrl(request)}/terms`
    });
  });

  app.get('/api/dashboard/calendar/status', requireDashboardAuth, async (request, response) => {
    const user = response.locals.dashboardUser;
    if (user.role !== 'DOCTOR' || !user.doctorId) {
      return response.status(403).json({ error: 'Doctor access required' });
    }
    const oauthStatus = getGoogleCalendarOAuthStatus(request);
    let doctorProfile;
    try {
      doctorProfile = await Doctor.findOne({ doctorId: user.doctorId, isActive: true })
        .select('+googleCredentialsEncrypted').lean();
    } catch (error) {
      console.error(`Calendar status lookup failed (${error?.name || 'Error'})`);
      return response.status(503).json({ error: 'Calendar status is temporarily unavailable' });
    }
    if (!doctorProfile) return response.status(403).json({ error: 'Doctor account is inactive' });

    const verification = await verifyDoctorCalendarAccess({
      doctorProfile,
      bootstrapDoctorId: clinicId,
      timeZone
    });
    response.json({
      connected: doctorProfile.googleCalendarConnected === true,
      verified: verification.verified,
      calendarId: verification.calendarId,
      calendarIdEditable: doctorProfile.googleCalendarId !== 'primary',
      verificationCode: verification.code,
      verificationMessage: verification.message,
      oauthAvailable: oauthStatus.available,
      oauthError: oauthStatus.error,
      redirectUri: oauthStatus.redirectUri
    });
  });

  app.put('/api/dashboard/calendar/settings', requireDashboardAuth, async (request, response) => {
    const user = response.locals.dashboardUser;
    if (user.role !== 'DOCTOR' || !user.doctorId) {
      return response.status(403).json({ error: 'Doctor access required' });
    }
    const googleCalendarId = typeof request.body?.googleCalendarId === 'string'
      ? request.body.googleCalendarId.trim()
      : '';
    if (!googleCalendarId || googleCalendarId.length > 250 || /[\r\n]/.test(googleCalendarId)) {
      return response.status(400).json({ error: 'Provide a valid Google Calendar ID (or email address).' });
    }

    try {
      const doctorProfile = await Doctor.findOneAndUpdate(
        { doctorId: user.doctorId, isActive: true },
        { $set: { googleCalendarId, updatedAt: new Date() } },
        { new: true, runValidators: true }
      ).select('+googleCredentialsEncrypted').lean();
      if (!doctorProfile) return response.status(403).json({ error: 'Doctor account is inactive' });

      const verification = await verifyDoctorCalendarAccess({
        doctorProfile,
        bootstrapDoctorId: clinicId,
        timeZone
      });
      response.json({
        googleCalendarId: doctorProfile.googleCalendarId,
        verified: verification.verified,
        verificationCode: verification.code,
        verificationMessage: verification.message
      });
    } catch (error) {
      console.error(`Calendar id update failed (${error?.name || 'Error'})`);
      response.status(503).json({ error: 'Calendar settings could not be saved' });
    }
  });

  app.post('/api/dashboard/calendar/disconnect', requireDashboardAuth, async (_request, response) => {
    const user = response.locals.dashboardUser;
    if (user.role !== 'DOCTOR' || !user.doctorId) {
      return response.status(403).json({ error: 'Doctor access required' });
    }
    try {
      const update = await Doctor.updateOne(
        { doctorId: user.doctorId, isActive: true },
        { $set: { googleCalendarConnected: false, updatedAt: new Date() }, $unset: { googleCredentialsEncrypted: 1 } }
      );
      if (update.matchedCount !== 1) return response.status(403).json({ error: 'Doctor account is inactive' });
      if (typeof whatsappConnection.syncReligiousHolidays === 'function') {
        await whatsappConnection.syncReligiousHolidays(user.doctorId).catch(() => {});
      }
      response.json({ connected: false });
    } catch (error) {
      console.error(`Calendar disconnect failed (${error?.name || 'Error'})`);
      response.status(503).json({ error: 'Calendar could not be disconnected' });
    }
  });

  app.post('/api/dashboard/whatsapp/connect', requireDashboardAuth, async (_request, response) => {
    const user = response.locals.dashboardUser;
    if (user.role !== 'DOCTOR' || !user.doctorId) {
      return response.status(403).json({ error: 'Doctor access required' });
    }
    if (!response.locals.doctor?.setupComplete) {
      return response.status(409).json({ error: 'Save your clinic setup before connecting WhatsApp' });
    }
    if (typeof whatsappConnection.startWhatsAppConnection !== 'function') {
      return response.status(503).json({ error: 'WhatsApp connection is unavailable' });
    }
    try {
      const state = await whatsappConnection.startWhatsAppConnection(user.doctorId);
      response.status(202).json(state || { status: 'starting' });
    } catch (error) {
      console.error(`WhatsApp connection start failed (${error?.name || 'Error'})`);
      response.status(503).json({ error: 'WhatsApp connection could not be started' });
    }
  });

  app.get('/api/dashboard/whatsapp/status', requireDashboardAuth, (_request, response) => {
    const user = response.locals.dashboardUser;
    if (user.role !== 'DOCTOR' || !user.doctorId) {
      return response.status(403).json({ error: 'Doctor access required' });
    }
    if (!response.locals.doctor?.setupComplete) {
      return response.status(409).json({ error: 'Save your clinic setup before connecting WhatsApp' });
    }
    const state = whatsappConnection.getWhatsAppConnectionStatus?.(user.doctorId) || { status: 'disconnected' };
    const sessionInfo = whatsappConnection.getWhatsAppSessionInfo?.() || {};
    response.json({
      status: state.status,
      qrDataUrl: state.qrDataUrl || null,
      sessionPersistent: sessionInfo.persistent !== false,
      sessionNotice: sessionInfo.notice || null
    });
  });

  app.put('/api/dashboard/settings', requireDashboardAuth, async (request, response) => {
    const doctor = response.locals.doctor;
    if (!doctor) return response.status(403).json({ error: 'Doctor access required' });
    const normalized = normalizeDoctorSettings(request.body);
    if (normalized.error) {
      return response.status(400).json({ error: normalized.error });
    }
    const normalizedSettings = normalized.settings;

    try {
      const updatedDoctor = await Doctor.findOneAndUpdate(
        { doctorId: doctor.doctorId, isActive: true },
        { $set: normalizedSettings },
        { new: true, runValidators: true }
      ).lean();
      if (!updatedDoctor) return response.status(403).json({ error: 'Doctor account is inactive' });
      if (typeof whatsappConnection.syncReligiousHolidays === 'function') {
        try {
          await whatsappConnection.syncReligiousHolidays(updatedDoctor.doctorId);
        } catch (error) {
          console.error(`Religious holiday calendar sync failed (${error?.name || 'Error'})`);
        }
      }
      const oauthStatus = getGoogleCalendarOAuthStatus(request);
      response.json({
        saved: true,
        droppedHolidayOverrides: normalized.droppedHolidayOverrides,
        doctorId: updatedDoctor.doctorId,
        doctorName: updatedDoctor.doctorName,
        clinicName: updatedDoctor.clinicName,
        facilitiesList: updatedDoctor.facilitiesList,
        basicCheckupFee: updatedDoctor.basicCheckupFee,
        facilityPricing: updatedDoctor.facilityPricing,
        servicesList: updatedDoctor.servicesList,
        consultationDetails: updatedDoctor.consultationDetails,
        workingDays: updatedDoctor.workingDays,
        offDays: updatedDoctor.offDays,
        ...resolveClinicTiming(updatedDoctor),
        religion: updatedDoctor.religion,
        setupComplete: updatedDoctor.setupComplete,
        welcomeMessage: updatedDoctor.welcomeMessage,
        googleCalendarConnected: updatedDoctor.googleCalendarConnected,
        calendarOAuthAvailable: oauthStatus.available,
        calendarOAuthError: oauthStatus.error,
        googleRedirectUri: oauthStatus.redirectUri,
        googleCalendarId: updatedDoctor.googleCalendarId
      });
    } catch (error) {
      console.error(`Doctor settings update failed (${error?.name || 'Error'})`);
      response.status(503).json({ error: 'Doctor settings could not be saved' });
    }
  });

  app.get('/api/admin/doctors', requireDashboardAuth, requireSuperadmin, async (_request, response) => {
    try {
      const [doctors, counts] = await Promise.all([
        Doctor.find().sort({ createdAt: -1 }).lean(),
        Appointment.aggregate([
          { $match: { status: 'booked' } },
          { $group: {
            _id: '$doctorId',
            totalAppointments: { $sum: 1 },
            upcomingAppointments: { $sum: { $cond: [{ $gt: ['$slotStart', new Date()] }, 1, 0] } }
          } }
        ])
      ]);
      const countByDoctor = new Map(counts.map((entry) => [entry._id, entry]));
      response.json({ doctors: doctors.map(({
        doctorId, doctorName, clinicName, email, isActive, createdAt, setupComplete, googleCalendarConnected
      }) => ({
        doctorId,
        doctorName,
        clinicName,
        email,
        isActive,
        setupComplete: setupComplete === true,
        googleCalendarConnected: googleCalendarConnected === true,
        createdAt,
        ...(countByDoctor.get(doctorId) || { totalAppointments: 0, upcomingAppointments: 0 })
      })) });
    } catch (error) {
      console.error(`Admin doctor listing failed (${error?.name || 'Error'})`);
      response.status(503).json({ error: 'Doctor list is temporarily unavailable' });
    }
  });

  app.get('/api/admin/doctors/:doctorId', requireDashboardAuth, requireSuperadmin, async (request, response) => {
    try {
      const doctor = await Doctor.findOne({ doctorId: request.params.doctorId }).lean();
      if (!doctor) return response.status(404).json({ error: 'Doctor not found' });
      const previewReligion = ['Christian', 'Muslim', 'Hindu', 'Other'].includes(request.query?.religion)
        ? request.query.religion
        : doctor.religion || 'Other';
      const currentDate = getLocalDateParts(new Date(), timeZone);
      const currentDateKey = formatClinicDateKey(currentDate);
      const oauthStatus = getGoogleCalendarOAuthStatus(request);
      response.json({
        doctorId: doctor.doctorId,
        doctorName: doctor.doctorName,
        clinicName: doctor.clinicName,
        email: doctor.email,
        facilitiesList: doctor.facilitiesList || [],
        servicesList: doctor.servicesList || [],
        facilityPricing: doctor.facilityPricing || [],
        basicCheckupFee: doctor.basicCheckupFee ?? null,
        consultationDetails: doctor.consultationDetails || '',
        workingDays: doctor.workingDays || [1, 2, 3, 4, 5],
        offDays: doctor.offDays || [],
        religiousHolidayOpenDays: doctor.religiousHolidayOpenDays || [],
        ...resolveClinicTiming(doctor),
        religiousHolidays: [...new Set([currentDate.year, currentDate.year + 1])]
          .flatMap((year) => getReligiousHolidays(previewReligion, year))
          .filter(({ date }) => date >= currentDateKey),
        religion: doctor.religion || 'Other',
        setupComplete: doctor.setupComplete === true,
        welcomeMessage: doctor.welcomeMessage || '',
        googleCalendarConnected: doctor.googleCalendarConnected === true,
        calendarOAuthAvailable: oauthStatus.available,
        calendarOAuthError: oauthStatus.error,
        googleRedirectUri: oauthStatus.redirectUri,
        googleCalendarId: doctor.googleCalendarId || 'primary',
        isActive: doctor.isActive !== false
      });
    } catch (error) {
      console.error(`Admin doctor profile read failed (${error?.name || 'Error'})`);
      response.status(503).json({ error: 'Doctor profile is temporarily unavailable' });
    }
  });

  app.put('/api/admin/doctors/:doctorId', requireDashboardAuth, requireSuperadmin, async (request, response) => {
    try {
      const existingDoctor = await Doctor.findOne({ doctorId: request.params.doctorId }).lean();
      if (!existingDoctor) return response.status(404).json({ error: 'Doctor not found' });

      const patch = normalizeAdminDoctorPatch(request.body || {}, existingDoctor);
      const emailProvided = request.body?.email !== undefined;
      const email = emailProvided && typeof request.body.email === 'string'
        ? request.body.email.trim().toLowerCase()
        : '';
      if (!patch || (emailProvided && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
        return response.status(400).json({ error: 'Provide valid doctor details. Every supplied field must pass validation.' });
      }
      if (emailProvided) {
        const existingUser = await DashboardUser.findOne({ email }).lean();
        if (existingUser && existingUser.doctorId !== request.params.doctorId) {
          return response.status(409).json({ error: 'That email is already assigned to another account.' });
        }
        patch.email = email;
      }

      const updatedDoctor = await Doctor.findOneAndUpdate(
        { doctorId: request.params.doctorId },
        { $set: patch },
        { new: true, runValidators: true }
      ).lean();
      if (!updatedDoctor) return response.status(404).json({ error: 'Doctor not found' });
      if (emailProvided) {
        await DashboardUser.updateMany({ doctorId: request.params.doctorId, role: 'DOCTOR' }, { $set: { email } });
      }
      if (typeof whatsappConnection.syncReligiousHolidays === 'function' && updatedDoctor.isActive) {
        await whatsappConnection.syncReligiousHolidays(updatedDoctor.doctorId).catch(() => {});
      }
      response.json({ doctor: {
        doctorId: updatedDoctor.doctorId,
        doctorName: updatedDoctor.doctorName,
        clinicName: updatedDoctor.clinicName,
        email: updatedDoctor.email,
        facilitiesList: updatedDoctor.facilitiesList,
        servicesList: updatedDoctor.servicesList,
        facilityPricing: updatedDoctor.facilityPricing,
        basicCheckupFee: updatedDoctor.basicCheckupFee,
        consultationDetails: updatedDoctor.consultationDetails,
        workingDays: updatedDoctor.workingDays,
        offDays: updatedDoctor.offDays,
        religiousHolidayOpenDays: updatedDoctor.religiousHolidayOpenDays || [],
        ...resolveClinicTiming(updatedDoctor),
        religion: updatedDoctor.religion,
        setupComplete: updatedDoctor.setupComplete,
        welcomeMessage: updatedDoctor.welcomeMessage
      } });
    } catch (error) {
      if (error.code === 11000) return response.status(409).json({ error: 'Doctor email is already in use.' });
      console.error(`Admin doctor profile update failed (${error?.name || 'Error'})`);
      response.status(503).json({ error: 'Doctor profile could not be saved' });
    }
  });

  app.post('/api/admin/doctors', requireDashboardAuth, requireSuperadmin, async (request, response) => {
    const { doctorName, clinicName, email, password, welcomeMessage } = request.body || {};
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (typeof doctorName !== 'string' || !doctorName.trim() || doctorName.length > 120 ||
      typeof clinicName !== 'string' || !clinicName.trim() || clinicName.length > 160 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) ||
      typeof password !== 'string' || password.length < 12 || password.length > 256 ||
      typeof welcomeMessage !== 'string' || welcomeMessage.length > 1000) {
      return response.status(400).json({ error: 'Provide doctor/clinic names and valid login details.' });
    }

    const baseSlug = clinicName.toLowerCase().normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'clinic';
    const doctorId = `${baseSlug}-${crypto.randomBytes(4).toString('hex')}`;
    let doctor;
    try {
      doctor = await Doctor.create({
        doctorId,
        doctorName: doctorName.trim(),
        clinicName: clinicName.trim(),
        email: normalizedEmail,
        welcomeMessage: welcomeMessage.trim(),
        googleCalendarId: 'primary',
        googleCalendarConnected: false,
        isActive: true
      });
      const user = await DashboardUser.create({
        email: normalizedEmail,
        passwordHash: await hashPassword(password),
        role: 'DOCTOR',
        doctorId,
        isActive: true
      });
      response.status(201).json({
        doctor: {
          doctorId: doctor.doctorId,
          doctorName: doctor.doctorName,
          clinicName: doctor.clinicName,
          email: doctor.email
        },
        userId: String(user._id)
      });
    } catch (error) {
      if (doctor) await Doctor.deleteOne({ _id: doctor._id });
      if (error.code === 11000) return response.status(409).json({ error: 'A doctor account with this email already exists.' });
      console.error(`Doctor provisioning failed (${error?.name || 'Error'})`);
      response.status(503).json({ error: 'Doctor account could not be created.' });
    }
  });

  app.patch('/api/admin/doctors/:doctorId/active', requireDashboardAuth, requireSuperadmin, async (request, response) => {
    const { isActive } = request.body || {};
    if (typeof isActive !== 'boolean') return response.status(400).json({ error: 'isActive must be a boolean' });

    try {
      const doctor = await Doctor.findOneAndUpdate(
        { doctorId: request.params.doctorId },
        { $set: { isActive, updatedAt: new Date() } },
        { new: true, runValidators: true }
      ).lean();
      if (!doctor) return response.status(404).json({ error: 'Doctor not found' });
      await DashboardUser.updateMany({ doctorId: doctor.doctorId, role: 'DOCTOR' }, { $set: { isActive } });
      response.json({ doctorId: doctor.doctorId, isActive: doctor.isActive });
    } catch (error) {
      console.error(`Doctor account update failed (${error?.name || 'Error'})`);
      response.status(503).json({ error: 'Doctor account could not be updated.' });
    }
  });

  // ---------------------------------------------------------------------------
  // Super Admin control panel. Every route below requires the SUPERADMIN role.
  // ---------------------------------------------------------------------------

  async function loadDoctorDirectory() {
    const doctors = await Doctor.find({}).sort({ createdAt: -1 }).lean();
    return new Map(doctors.map((doctor) => [doctor.doctorId, doctor]));
  }

  app.get('/api/admin/overview', requireDashboardAuth, requireSuperadmin, async (_request, response) => {
    try {
      const now = new Date();
      const todayBounds = getLocalDayBounds(getLocalDateParts(now, timeZone), timeZone);
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const [
        doctorCount, activeDoctorCount, setupPendingCount,
        totalAppointments, upcomingAppointments, todayAppointments, last30DaysAppointments,
        uniquePatients, messagesLast24h, errorsLast30Days, warningsLast30Days,
        reportRuns
      ] = await Promise.all([
        Doctor.countDocuments({}),
        Doctor.countDocuments({ isActive: true }),
        Doctor.countDocuments({ setupComplete: { $ne: true } }),
        Appointment.countDocuments({ status: 'booked' }),
        Appointment.countDocuments({ status: 'booked', slotStart: { $gt: now } }),
        Appointment.countDocuments({ status: 'booked', slotStart: { $gte: todayBounds.start, $lt: todayBounds.end } }),
        Appointment.countDocuments({ status: 'booked', bookedAt: { $gte: thirtyDaysAgo } }),
        Appointment.distinct('senderJid', { status: 'booked' }).then((values) => values.length),
        InboundMessage.countDocuments({ receivedAt: { $gte: dayAgo } }),
        ServiceLog.countDocuments({ level: 'error', createdAt: { $gte: thirtyDaysAgo } }),
        ServiceLog.countDocuments({ level: 'warn', createdAt: { $gte: thirtyDaysAgo } }),
        DailyReportRun.find({ status: 'failed', lockExpiresAt: { $gte: thirtyDaysAgo } })
          .select('doctorId dateKey').limit(50).lean()
      ]);

      const reportFailuresByDoctor = {};
      for (const run of reportRuns) {
        reportFailuresByDoctor[run.doctorId] = (reportFailuresByDoctor[run.doctorId] || 0) + 1;
      }

      response.json({
        generatedAt: now.toISOString(),
        timeZone,
        doctors: { total: doctorCount, active: activeDoctorCount, setupPending: setupPendingCount },
        appointments: {
          total: totalAppointments,
          upcoming: upcomingAppointments,
          today: todayAppointments,
          last30Days: last30DaysAppointments,
          uniquePatients
        },
        messaging: { receivedLast24Hours: messagesLast24h },
        operations: { errorsLast30Days, warningsLast30Days, failedDailyReports: reportRuns.length, reportFailuresByDoctor }
      });
    } catch (error) {
      console.error(`Admin overview failed (${error?.name || 'Error'})`);
      response.status(503).json({ error: 'Platform overview is temporarily unavailable' });
    }
  });

  app.get('/api/admin/appointments', requireDashboardAuth, requireSuperadmin, async (request, response) => {
    const limit = clampInteger(request.query.limit, { min: 1, max: 200, fallback: 50 });
    const filter = { status: 'booked' };
    if (isValidDoctorSlug(request.query.doctorId)) {
      filter.doctorId = request.query.doctorId;
    } else if (request.query.doctorId) {
      return response.status(400).json({ error: 'doctorId is not a valid clinic id' });
    }
    if (isValidDateKey(request.query.from) || isValidDateKey(request.query.to)) {
      filter.slotStart = {};
      if (isValidDateKey(request.query.from)) {
        filter.slotStart.$gte = getLocalDayBounds({
          year: Number(request.query.from.slice(0, 4)),
          month: Number(request.query.from.slice(5, 7)),
          day: Number(request.query.from.slice(8, 10))
        }, timeZone).start;
      }
      if (isValidDateKey(request.query.to)) {
        filter.slotStart.$lt = getLocalDayBounds({
          year: Number(request.query.to.slice(0, 4)),
          month: Number(request.query.to.slice(5, 7)),
          day: Number(request.query.to.slice(8, 10))
        }, timeZone).end;
      }
    }
    if (request.query.upcoming === 'true') filter.slotStart = { ...(filter.slotStart || {}), $gt: new Date() };

    const search = typeof request.query.q === 'string' ? request.query.q.trim().slice(0, 60) : '';
    if (search) {
      const pattern = new RegExp(escapeRegExp(search), 'i');
      filter.$or = [{ 'details.name': pattern }, { 'details.contactNumber': pattern }, { senderJid: pattern }];
    }

    try {
      const [appointments, total, directory] = await Promise.all([
        Appointment.find(filter).sort({ slotStart: -1 }).limit(limit).lean(),
        Appointment.countDocuments(filter),
        loadDoctorDirectory()
      ]);
      response.json({
        total,
        limit,
        timeZone,
        appointments: appointments.map((appointment) => {
          const doctor = directory.get(appointment.doctorId);
          return {
            id: String(appointment._id),
            doctorId: appointment.doctorId,
            doctorName: doctor?.doctorName || appointment.doctorId,
            clinicName: doctor?.clinicName || null,
            patientName: appointment.details?.name || '',
            whatsAppNumber: appointment.details?.contactNumber || '',
            symptoms: appointment.details?.majorSymptoms || '',
            slotStart: appointment.slotStart,
            slotEnd: appointment.slotEnd,
            bookedAt: appointment.bookedAt || null,
            status: appointment.status
          };
        })
      });
    } catch (error) {
      console.error(`Admin appointments failed (${error?.name || 'Error'})`);
      response.status(503).json({ error: 'Appointments are temporarily unavailable' });
    }
  });

  app.get('/api/admin/analytics', requireDashboardAuth, requireSuperadmin, async (request, response) => {
    const days = clampInteger(request.query.days, { min: 7, max: 90, fallback: 14 });
    try {
      const now = new Date();
      const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

      const [daily, perDoctor, directory, messageTotals, errorTotals] = await Promise.all([
        Appointment.aggregate([
          { $match: { status: 'booked', bookedAt: { $gte: since } } },
          { $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$bookedAt', timezone: timeZone } },
            appointments: { $sum: 1 }
          } },
          { $sort: { _id: 1 } }
        ]),
        Appointment.aggregate([
          { $match: { status: 'booked' } },
          { $group: {
            _id: '$doctorId',
            total: { $sum: 1 },
            upcoming: { $sum: { $cond: [{ $gt: ['$slotStart', now] }, 1, 0] } },
            inPeriod: { $sum: { $cond: [{ $gte: ['$bookedAt', since] }, 1, 0] } },
            lastBookedAt: { $max: '$bookedAt' }
          } }
        ]),
        loadDoctorDirectory(),
        InboundMessage.aggregate([
          { $match: { receivedAt: { $gte: since } } },
          { $group: { _id: '$doctorId', messages: { $sum: 1 }, voice: { $sum: { $cond: [{ $eq: ['$messageType', 'audio'] }, 1, 0] } } } }
        ]),
        ServiceLog.aggregate([
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: { doctorId: '$doctorId', level: '$level' }, count: { $sum: 1 } } }
        ])
      ]);

      const doctorRows = [...directory.values()].map((doctor) => ({ doctor, metrics: null }));
      const byDoctorId = new Map(doctorRows.map((row) => [row.doctor.doctorId, row]));
      for (const entry of perDoctor) {
        const row = byDoctorId.get(entry._id);
        if (row) row.metrics = entry;
      }
      const messagesByDoctor = new Map(messageTotals.map((entry) => [entry._id, entry]));
      const errorsByDoctor = new Map();
      for (const entry of errorTotals) {
        errorsByDoctor.set(entry._id.doctorId, {
          ...(errorsByDoctor.get(entry._id.doctorId) || {}),
          [entry._id.level]: entry.count
        });
      }

      response.json({
        generatedAt: now.toISOString(),
        days,
        since: since.toISOString(),
        timeZone,
        dailyBookings: daily.map((entry) => ({ date: entry._id, appointments: entry.appointments })),
        doctors: doctorRows.map(({ doctor, metrics }) => {
          const messages = messagesByDoctor.get(doctor.doctorId);
          const problems = errorsByDoctor.get(doctor.doctorId);
          return {
            doctorId: doctor.doctorId,
            doctorName: doctor.doctorName,
            clinicName: doctor.clinicName,
            email: doctor.email,
            isActive: doctor.isActive !== false,
            setupComplete: doctor.setupComplete === true,
            googleCalendarConnected: doctor.googleCalendarConnected === true,
            totalAppointments: metrics?.total || 0,
            upcomingAppointments: metrics?.upcoming || 0,
            periodAppointments: metrics?.inPeriod || 0,
            lastBookedAt: metrics?.lastBookedAt || null,
            messagesReceived: messages?.messages || 0,
            voiceMessages: messages?.voice || 0,
            errors: problems?.error || 0,
            warnings: problems?.warn || 0
          };
        })
      });
    } catch (error) {
      console.error(`Admin analytics failed (${error?.name || 'Error'})`);
      response.status(503).json({ error: 'Analytics are temporarily unavailable' });
    }
  });

  app.get('/api/admin/system', requireDashboardAuth, requireSuperadmin, async (request, response) => {
    try {
      const memory = process.memoryUsage();
      const sessionInfo = typeof whatsappConnection.getWhatsAppSessionInfo === 'function'
        ? whatsappConnection.getWhatsAppSessionInfo()
        : {};
      const connectionStatuses = typeof whatsappConnection.listWhatsAppStatuses === 'function'
        ? whatsappConnection.listWhatsAppStatuses()
        : [];
      const oauthStatus = getGoogleCalendarOAuthStatus(request);

      const doctorStatuses = await Doctor.find({}).select('doctorId googleCalendarConnected isActive setupComplete').lean();

      response.json({
        runtime: {
          nodeVersion: process.version,
          platform: process.platform,
          uptimeSeconds: Math.round(process.uptime()),
          memoryRoundedMb: Math.round(memory.rss / 1024 / 1024),
          heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
          timeZone
        },
        configuration: {
          nodeEnv: process.env.NODE_ENV || 'development',
          port: Number(process.env.PORT) || 3000,
          trustProxy: process.env.TRUST_PROXY === 'true',
          databaseConnected: mongoose.connection.readyState === 1,
          databaseHost: maskDatabaseUri(process.env.MONGODB_URI),
          geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
          geminiPatientDataAllowed: process.env.GEMINI_ALLOW_PHI_PROCESSING === 'true',
          voiceTranscriptionEnabled: process.env.OPENAI_ALLOW_PHI_PROCESSING === 'true' && Boolean(process.env.OPENAI_API_KEY),
          googleClientConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
          googleRedirectUri: oauthStatus.redirectUri,
          googleRedirectUriValid: oauthStatus.available,
          smtpConfigured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
          emailFromConfigured: Boolean(process.env.EMAIL_FROM)
        },
        whatsapp: {
          authDirectory: sessionInfo.authDirectory || null,
          sessionPersistent: sessionInfo.persistent !== false,
          sessionNotice: sessionInfo.notice || null,
          connections: connectionStatuses
        },
        clinics: doctorStatuses.map((doctor) => ({
          doctorId: doctor.doctorId,
          isActive: doctor.isActive !== false,
          setupComplete: doctor.setupComplete === true,
          googleCalendarConnected: doctor.googleCalendarConnected === true
        }))
      });
    } catch (error) {
      console.error(`Admin system status failed (${error?.name || 'Error'})`);
      response.status(503).json({ error: 'System status is temporarily unavailable' });
    }
  });

  app.get('/api/admin/service-logs', requireDashboardAuth, requireSuperadmin, async (request, response) => {
    const limit = clampInteger(request.query.limit, { min: 1, max: 200, fallback: 50 });
    const filter = {};
    if (['error', 'warn', 'info'].includes(request.query.level)) filter.level = request.query.level;
    if (isValidDoctorSlug(request.query.doctorId)) filter.doctorId = request.query.doctorId;

    try {
      const [logs, directory] = await Promise.all([
        ServiceLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
        loadDoctorDirectory()
      ]);
      response.json({
        timeZone,
        logs: logs.map((log) => ({
          id: String(log._id),
          doctorId: log.doctorId,
          doctorName: directory.get(log.doctorId)?.doctorName || log.doctorId,
          level: log.level,
          event: log.event,
          code: log.code || null,
          createdAt: log.createdAt
        }))
      });
    } catch (error) {
      console.error(`Admin service logs failed (${error?.name || 'Error'})`);
      response.status(503).json({ error: 'Service logs are temporarily unavailable' });
    }
  });
}

module.exports = {
  createGoogleOAuthState,
  createSessionToken,
  getGoogleCalendarConfigurationError,
  getGoogleCalendarOAuthStatus,
  mountDashboard,
  normalizeAdminDoctorPatch,
  resolveGoogleRedirectUri,
  verifyGoogleOAuthState,
  verifySessionToken
};