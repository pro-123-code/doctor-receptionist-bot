const { google } = require('googleapis');
const { decryptJson } = require('./secretBox');
const { getCalendarErrorDetails } = require('./calendarErrors');

function createMissingCredentialError(name) {
  return Object.assign(new Error(`Missing Google Calendar configuration: ${name}`), {
    code: 'GOOGLE_CREDENTIALS_INCOMPLETE'
  });
}

// Per-doctor encrypted credentials win. The bootstrap tenant may fall back to the
// shared environment credentials so a single-clinic deployment keeps working.
function resolveGoogleCredentials(doctorProfile, environment = process.env, bootstrapDoctorId = null) {
  let storedCredentials = null;
  if (doctorProfile?.googleCredentialsEncrypted) {
    try {
      storedCredentials = decryptJson(doctorProfile.googleCredentialsEncrypted, environment);
    } catch {
      storedCredentials = null;
    }
  } else if (bootstrapDoctorId && doctorProfile?.doctorId === bootstrapDoctorId) {
    storedCredentials = {
      clientId: environment.GOOGLE_CLIENT_ID,
      clientSecret: environment.GOOGLE_CLIENT_SECRET,
      refreshToken: environment.GOOGLE_REFRESH_TOKEN
    };
  }

  return {
    clientId: storedCredentials?.clientId || environment.GOOGLE_CLIENT_ID || null,
    clientSecret: storedCredentials?.clientSecret || environment.GOOGLE_CLIENT_SECRET || null,
    refreshToken: storedCredentials?.refreshToken || null
  };
}

function createCalendarApiClient(credentials) {
  if (!credentials.clientId) throw createMissingCredentialError('GOOGLE_CLIENT_ID');
  if (!credentials.clientSecret) throw createMissingCredentialError('GOOGLE_CLIENT_SECRET');
  if (!credentials.refreshToken) throw createMissingCredentialError('GOOGLE_REFRESH_TOKEN');

  const auth = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
  auth.setCredentials({ refresh_token: credentials.refreshToken });
  return google.calendar({ version: 'v3', auth });
}

// A stored refresh token can silently expire or be revoked, so "connected" must be
// proven against Google rather than trusted from a stored boolean flag.
async function verifyDoctorCalendarAccess({
  doctorProfile,
  environment = process.env,
  bootstrapDoctorId = null,
  timeZone = 'Asia/Karachi',
  timeoutMs = 15000
}) {
  const calendarId = doctorProfile?.googleCalendarId || 'primary';
  if (!doctorProfile?.googleCredentialsEncrypted && !(bootstrapDoctorId && doctorProfile?.doctorId === bootstrapDoctorId)) {
    return {
      verified: false,
      calendarId,
      status: null,
      code: 'CALENDAR_NOT_CONNECTED',
      message: 'This clinic has not connected a Google Calendar yet.'
    };
  }

  let credentials;
  try {
    credentials = resolveGoogleCredentials(doctorProfile, environment, bootstrapDoctorId);
    const calendar = createCalendarApiClient(credentials);
    const now = new Date();
    // Verify with the same call booking relies on, so verification only needs the
    // narrow free/busy scope rather than a broader calendar listing scope.
    await Promise.race([
      calendar.freebusy.query({
        requestBody: {
          timeMin: now.toISOString(),
          timeMax: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
          timeZone: timeZone,
          items: [{ id: calendarId }]
        }
      }),
      new Promise((_resolve, reject) => setTimeout(
        () => reject(Object.assign(new Error('Google Calendar verification timed out'), { code: 'CALENDAR_VERIFICATION_TIMEOUT' })),
        timeoutMs
      ))
    ]);
    return { verified: true, calendarId, status: 200, code: null, message: null };
  } catch (error) {
    const details = getCalendarErrorDetails(error, environment);
    const status = details.status ?? error.response?.status ?? error.code ?? null;
    const code = details.code || String(error.code || 'CALENDAR_VERIFICATION_FAILED');
    return {
      verified: false,
      calendarId,
      status: typeof status === 'number' ? status : null,
      code,
      message: describeCalendarFailure(code, details.message)
    };
  }
}

function describeCalendarFailure(code, message) {
  const detail = message || 'Google Calendar could not be reached.';
  if (code === 'invalid_grant' || /invalid_grant/i.test(detail)) {
    return `Google rejected the stored refresh token (invalid_grant). Reconnect the calendar from the dashboard. ${detail}`;
  }
  if (/has not been used|is disabled|not enabled|accessNotConfigured/i.test(detail)) {
    return `The Google Calendar API is not enabled for this OAuth project. Enable "Google Calendar API" in Google Cloud Console, then reconnect. ${detail}`;
  }
  if (code === 'CALENDAR_NOT_FOUND' || /notFound/i.test(detail)) {
    return `The connected Google account does not expose the configured calendar. Reconnect and pick a calendar. ${detail}`;
  }
  if (/insufficient|insufficientPermissions|403/i.test(detail)) {
    return `Google denied calendar access. Remove the app in Google account permissions and reconnect. ${detail}`;
  }
  if (code === 'CALENDAR_VERIFICATION_TIMEOUT') {
    return 'Google Calendar did not respond in time. Try again in a moment.';
  }
  return detail;
}

module.exports = {
  createCalendarApiClient,
  describeCalendarFailure,
  resolveGoogleCredentials,
  verifyDoctorCalendarAccess
};