const crypto = require('node:crypto');
const path = require('node:path');
const { google } = require('googleapis');
const { getLocalDateParts, getLocalDayBounds } = require('./dateParser');
const { DashboardUser, Doctor, consumeDashboardLoginAttempt } = require('./models');
const { hashPassword, verifyPassword } = require('./passwords');
const { encryptJson, hasValidEncryptionKey } = require('./secretBox');
const { normalizeOffDays, normalizeWorkingDays } = require('./clinicSchedule');

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

function normalizeFacilitiesList(value) {
  if (!Array.isArray(value)) return null;
  const facilities = value.map((facility) => String(facility).trim()).filter(Boolean);
  if (facilities.length < 1 || facilities.length > 20 || facilities.some((facility) => facility.length > 100)) {
    return null;
  }
  return [...new Set(facilities)];
}

function isGoogleCalendarOAuthAvailable() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI && hasValidEncryptionKey());
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

  app.get('/api/auth/google', requireDashboardAuth, async (_request, response) => {
    const user = response.locals.dashboardUser;
    const secret = getDashboardSecret();
    if (user.role !== 'DOCTOR' || !user.doctorId) {
      return response.status(403).json({ error: 'Doctor access required' });
    }
    if (!secret || !isGoogleCalendarOAuthAvailable()) {
      return response.status(503).json({ error: 'Google Calendar OAuth is not configured' });
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
        process.env.GOOGLE_REDIRECT_URI
      );
      response.redirect(oauthClient.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: true,
        scope: ['https://www.googleapis.com/auth/calendar'],
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
    if (request.query.error) return response.status(400).send('Google Calendar connection was cancelled.');

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
        process.env.GOOGLE_REDIRECT_URI
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
      doctorName: response.locals.doctor?.name || null,
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

  app.get('/api/dashboard/settings', requireDashboardAuth, (_request, response) => {
    const doctor = response.locals.doctor;
    if (!doctor) return response.status(403).json({ error: 'Doctor access required' });
    response.json({
      doctorId: doctor.doctorId,
      doctorName: doctor.doctorName,
      clinicName: doctor.clinicName,
      email: doctor.email,
      facilitiesList: doctor.facilitiesList,
      servicesList: doctor.servicesList || [],
      consultationDetails: doctor.consultationDetails || '',
      workingDays: doctor.workingDays || [1, 2, 3, 4, 5],
      offDays: doctor.offDays || [],
      setupComplete: doctor.setupComplete === true,
      religion: doctor.religion || 'Other',
      welcomeMessage: doctor.welcomeMessage,
      googleCalendarConnected: doctor.googleCalendarConnected,
      calendarOAuthAvailable: isGoogleCalendarOAuthAvailable(),
      googleCalendarId: doctor.googleCalendarId
    });
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
    response.json({ status: state.status, qrDataUrl: state.qrDataUrl || null });
  });

  app.put('/api/dashboard/settings', requireDashboardAuth, async (request, response) => {
    const doctor = response.locals.doctor;
    if (!doctor) return response.status(403).json({ error: 'Doctor access required' });
    const {
      doctorName, clinicName, facilitiesList, servicesList, consultationDetails,
      workingDays, offDays, religion, welcomeMessage
    } = request.body || {};
    const normalizedFacilities = normalizeFacilitiesList(facilitiesList);
    const normalizedServices = normalizeFacilitiesList(servicesList);
    const normalizedWorkingDays = normalizeWorkingDays(workingDays);
    const normalizedOffDays = normalizeOffDays(offDays);
    if (typeof doctorName !== 'string' || !doctorName.trim() || doctorName.length > 120 ||
      typeof clinicName !== 'string' || !clinicName.trim() || clinicName.length > 160 ||
      !normalizedFacilities || !normalizedServices || !normalizedWorkingDays || !normalizedOffDays ||
      typeof consultationDetails !== 'string' || !consultationDetails.trim() || consultationDetails.length > 2000 ||
      !['Christian', 'Muslim', 'Hindu', 'Other'].includes(religion) ||
      typeof welcomeMessage !== 'string' || welcomeMessage.length > 1000) {
      return response.status(400).json({ error: 'Provide doctor and clinic names, facilities, services, consultation details, working days, valid off-days, and a welcome message under 1000 characters.' });
    }

    try {
      const updatedDoctor = await Doctor.findOneAndUpdate(
        { doctorId: doctor.doctorId, isActive: true },
        { $set: {
          doctorName: doctorName.trim(),
          clinicName: clinicName.trim(),
          facilitiesList: normalizedFacilities,
          servicesList: normalizedServices,
          consultationDetails: consultationDetails.trim(),
          workingDays: normalizedWorkingDays,
          offDays: normalizedOffDays,
          religion,
          setupComplete: true,
          welcomeMessage: welcomeMessage.trim(),
          updatedAt: new Date()
        } },
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
      response.json({
        doctorId: updatedDoctor.doctorId,
        doctorName: updatedDoctor.doctorName,
        clinicName: updatedDoctor.clinicName,
        facilitiesList: updatedDoctor.facilitiesList,
        servicesList: updatedDoctor.servicesList,
        consultationDetails: updatedDoctor.consultationDetails,
        workingDays: updatedDoctor.workingDays,
        offDays: updatedDoctor.offDays,
        religion: updatedDoctor.religion,
        setupComplete: updatedDoctor.setupComplete,
        welcomeMessage: updatedDoctor.welcomeMessage,
        googleCalendarConnected: updatedDoctor.googleCalendarConnected,
        calendarOAuthAvailable: isGoogleCalendarOAuthAvailable(),
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
      response.json({ doctors: doctors.map(({ doctorId, doctorName, clinicName, email, isActive, createdAt }) => ({
        doctorId,
        doctorName,
        clinicName,
        email,
        isActive,
        createdAt,
        ...(countByDoctor.get(doctorId) || { totalAppointments: 0, upcomingAppointments: 0 })
      })) });
    } catch (error) {
      console.error(`Admin doctor listing failed (${error?.name || 'Error'})`);
      response.status(503).json({ error: 'Doctor list is temporarily unavailable' });
    }
  });

  app.post('/api/admin/doctors', requireDashboardAuth, requireSuperadmin, async (request, response) => {
    const { doctorName, clinicName, email, password, facilitiesList, welcomeMessage } = request.body || {};
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const normalizedFacilities = normalizeFacilitiesList(facilitiesList);
    if (typeof doctorName !== 'string' || !doctorName.trim() || doctorName.length > 120 ||
      typeof clinicName !== 'string' || !clinicName.trim() || clinicName.length > 160 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) ||
      typeof password !== 'string' || password.length < 12 || password.length > 256 ||
      !normalizedFacilities || typeof welcomeMessage !== 'string' || welcomeMessage.length > 1000) {
      return response.status(400).json({ error: 'Provide doctor/clinic names, login details, 1-20 facilities, and a welcome message under 1000 characters.' });
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
        facilitiesList: normalizedFacilities,
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
          email: doctor.email,
          facilitiesList: doctor.facilitiesList
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
}

module.exports = {
  createGoogleOAuthState,
  createSessionToken,
  mountDashboard,
  verifyGoogleOAuthState,
  verifySessionToken
};