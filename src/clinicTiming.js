// Clinic opening hours, slot length and booking window are per-clinic settings that
// live on the Doctor record. They fall back to the environment defaults so existing
// clinics keep working without a migration, and so a single-clinic deployment can
// still be configured entirely through .env.

const DEFAULTS = {
  officeStartHour: 9,
  officeEndHour: 17,
  appointmentDurationMinutes: 30,
  appointmentLookaheadDays: 7
};

const LIMITS = {
  officeStartHour: { min: 0, max: 23 },
  officeEndHour: { min: 1, max: 24 },
  appointmentDurationMinutes: { min: 15, max: 240 },
  appointmentLookaheadDays: { min: 1, max: 30 }
};

function isValidHourSetting(name, value) {
  const limits = LIMITS[name];
  if (!limits) return false;
  return Number.isInteger(value) && value >= limits.min && value <= limits.max;
}

const ENVIRONMENT_KEYS = {
  officeStartHour: 'OFFICE_START_HOUR',
  officeEndHour: 'OFFICE_END_HOUR',
  appointmentDurationMinutes: 'APPOINTMENT_DURATION_MINUTES',
  appointmentLookaheadDays: 'APPOINTMENT_LOOKAHEAD_DAYS'
};

function readEnvironmentDefault(name, environment) {
  const raw = environment[ENVIRONMENT_KEYS[name]];
  const parsed = Number.parseInt(raw, 10);
  return isValidHourSetting(name, parsed) ? parsed : DEFAULTS[name];
}

function resolveEnvironmentTiming(environment = process.env) {
  const timing = {
    officeStartHour: readEnvironmentDefault('officeStartHour', environment),
    officeEndHour: readEnvironmentDefault('officeEndHour', environment),
    appointmentDurationMinutes: readEnvironmentDefault('appointmentDurationMinutes', environment),
    appointmentLookaheadDays: readEnvironmentDefault('appointmentLookaheadDays', environment)
  };
  // An inverted or zero-length window would generate no slots at all.
  if (timing.officeStartHour >= timing.officeEndHour) {
    timing.officeStartHour = DEFAULTS.officeStartHour;
    timing.officeEndHour = DEFAULTS.officeEndHour;
  }
  return { ...timing, usingEnvironment: true };
}

// Effective timing for a clinic: saved values win, environment fills the gaps.
function resolveClinicTiming(doctorProfile, environment = process.env) {
  const fallback = resolveEnvironmentTiming(environment);
  const pick = (name) => (
    isValidHourSetting(name, doctorProfile?.[name]) ? doctorProfile[name] : fallback[name]
  );

  const timing = {
    officeStartHour: pick('officeStartHour'),
    officeEndHour: pick('officeEndHour'),
    appointmentDurationMinutes: pick('appointmentDurationMinutes'),
    appointmentLookaheadDays: pick('appointmentLookaheadDays')
  };
  if (timing.officeStartHour >= timing.officeEndHour) {
    return fallback;
  }
  return {
    ...timing,
    usingEnvironment: Object.keys(DEFAULTS).every((name) => fallback[name] === timing[name])
  };
}

// Validate the timing fields a dashboard submission supplied. Fields that are absent
// are left untouched so partial edits stay partial. Returns null when anything
// supplied is invalid, so callers can reject the whole save.
function normalizeClinicTimingInput(body = {}) {
  const patch = {};
  for (const name of Object.keys(DEFAULTS)) {
    if (body[name] === undefined || body[name] === null || body[name] === '') continue;
    const value = typeof body[name] === 'string' ? Number(body[name]) : body[name];
    if (!isValidHourSetting(name, value)) return null;
    patch[name] = value;
  }

  const mergedStart = patch.officeStartHour ?? undefined;
  const mergedEnd = patch.officeEndHour ?? undefined;
  if (mergedStart !== undefined && mergedEnd !== undefined && mergedStart >= mergedEnd) return null;
  return patch;
}

const reportTimePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const defaultReportTime = '00:00';

function normalizeReportTime(value) {
  if (value === undefined || value === null || value === '') return defaultReportTime;
  const candidate = String(value).trim();
  if (!reportTimePattern.test(candidate)) return null;
  return candidate;
}

// HH:MM in a fixed clinic-local zone, used by the daily report scheduler.
function currentLocalTime(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === 'hour')?.value || '00';
  const minute = parts.find((part) => part.type === 'minute')?.value || '00';
  return `${hour}:${minute}`;
}

function isReportDueNow(doctorProfile, date = new Date(), timeZone = 'Asia/Karachi') {
  const reportTime = normalizeReportTime(doctorProfile?.reportTime) ?? defaultReportTime;
  return currentLocalTime(date, timeZone) === reportTime;
}

module.exports = {
  DEFAULTS,
  LIMITS,
  currentLocalTime,
  isReportDueNow,
  isValidHourSetting,
  normalizeClinicTimingInput,
  normalizeReportTime,
  resolveClinicTiming,
  resolveEnvironmentTiming
};