const chrono = require('chrono-node');

function getLocalDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  return Object.fromEntries(
    parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, Number(value)])
  );
}

function addDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function localDateTimeToUtc(parts, timeZone, hour = 0, minute = 0) {
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute);
  const zonedParts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(utcGuess)).reduce((result, { type, value }) => {
    if (type !== 'literal') result[type] = Number(value);
    return result;
  }, {});
  const actualAsUtc = Date.UTC(
    zonedParts.year,
    zonedParts.month - 1,
    zonedParts.day,
    zonedParts.hour,
    zonedParts.minute,
    zonedParts.second
  );
  return new Date(utcGuess + (utcGuess - actualAsUtc));
}

function getLocalDayBounds(parts, timeZone) {
  const nextDay = addDays(parts, 1);
  return {
    start: localDateTimeToUtc(parts, timeZone),
    end: localDateTimeToUtc(nextDay, timeZone)
  };
}

function dateOrdinal(parts) {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000);
}

function parseRequestedDate(message, timeZone, lookaheadDays, now = new Date()) {
  if (typeof message !== 'string' || !message.trim()) return null;

  const today = getLocalDateParts(now, timeZone);
  let requestedDate;
  if (/\b(kal|tomorrow|tmrw)\b/i.test(message)) {
    requestedDate = addDays(today, 1);
  } else {
    const referenceDate = localDateTimeToUtc(today, timeZone, 12);
    const parsed = chrono.parse(message, referenceDate, { forwardDate: true })[0];
    if (!parsed) return null;
    requestedDate = {
      year: parsed.start.get('year'),
      month: parsed.start.get('month'),
      day: parsed.start.get('day')
    };
  }

  if (!requestedDate.year || !requestedDate.month || !requestedDate.day) return null;
  const daysAhead = dateOrdinal(requestedDate) - dateOrdinal(today);
  if (daysAhead < 0 || daysAhead > lookaheadDays) return null;
  return requestedDate;
}

module.exports = {
  addDays,
  getLocalDateParts,
  getLocalDayBounds,
  localDateTimeToUtc,
  parseRequestedDate
};