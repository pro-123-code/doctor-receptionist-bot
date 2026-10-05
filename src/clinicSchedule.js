const Holidays = require('date-holidays');

const holidayRules = {
  Christian: [
    { country: 'US', match: /Easter Sunday|Christmas Eve|Christmas Day/i }
  ],
  Muslim: [
    { country: 'PK', match: /Eid al-Fitr|Eid al-Adha|End of Ramadan|Feast of the Sacrifice/i }
  ],
  Hindu: [
    { country: 'TT', match: /Deepavali/i },
    { country: 'SR', match: /Holi|Holifeest|Phagwah/i }
  ]
};
const religiousHolidayCache = new Map();

function isValidClinicDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function normalizeWorkingDays(value) {
  if (!Array.isArray(value) || value.length === 0 ||
    value.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return null;
  return [...new Set(value)].sort((left, right) => left - right);
}

function normalizeOffDays(value) {
  if (!Array.isArray(value) || value.length > 366 || value.some((date) => !isValidClinicDateKey(date))) {
    return null;
  }
  return [...new Set(value)].sort();
}

function getReligiousHolidays(religion, year) {
  const cacheKey = `${religion}:${year}`;
  if (religiousHolidayCache.has(cacheKey)) return religiousHolidayCache.get(cacheKey);
  const rules = holidayRules[religion] || [];
  const holidays = rules.flatMap(({ country, match }) => new Holidays(country)
    .getHolidays(year)
    .filter(({ name }) => match.test(name))
    .map(({ date, name }) => ({ date: date.slice(0, 10), name })));
  const uniqueHolidays = [...new Map(holidays.map((holiday) => [holiday.date, holiday])).values()]
    .sort((left, right) => left.date.localeCompare(right.date));
  religiousHolidayCache.set(cacheKey, uniqueHolidays);
  return uniqueHolidays;
}

function getReligiousHoliday(religion, dateKey) {
  if (!isValidClinicDateKey(dateKey)) return null;
  const year = Number(dateKey.slice(0, 4));
  return getReligiousHolidays(religion, year).find((holiday) => holiday.date === dateKey) || null;
}

function isClinicOpenOnDate(dateParts, doctorSchedule) {
  const dateKey = `${dateParts.year}-${String(dateParts.month).padStart(2, '0')}-${String(dateParts.day).padStart(2, '0')}`;
  if (!isValidClinicDateKey(dateKey) || doctorSchedule.offDays?.includes(dateKey) ||
    getReligiousHoliday(doctorSchedule.religion, dateKey)) return false;
  const weekday = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day)).getUTCDay();
  return doctorSchedule.workingDays?.includes(weekday) === true;
}

module.exports = {
  getReligiousHoliday,
  getReligiousHolidays,
  isClinicOpenOnDate,
  isValidClinicDateKey,
  normalizeOffDays,
  normalizeWorkingDays
};