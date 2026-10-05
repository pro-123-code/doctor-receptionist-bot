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

function isClinicOpenOnDate(dateParts, doctorSchedule) {
  const dateKey = `${dateParts.year}-${String(dateParts.month).padStart(2, '0')}-${String(dateParts.day).padStart(2, '0')}`;
  if (!isValidClinicDateKey(dateKey) || doctorSchedule.offDays?.includes(dateKey)) return false;
  const weekday = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day)).getUTCDay();
  return doctorSchedule.workingDays?.includes(weekday) === true;
}

module.exports = { isClinicOpenOnDate, isValidClinicDateKey, normalizeOffDays, normalizeWorkingDays };