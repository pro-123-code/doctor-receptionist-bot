const crypto = require('node:crypto');
const { addDays, getLocalDateParts } = require('./dateParser');

function formatDateKey(dateParts) {
  return `${dateParts.year}-${String(dateParts.month).padStart(2, '0')}-${String(dateParts.day).padStart(2, '0')}`;
}

async function syncReligiousHolidayEvents({
  doctorProfile,
  Doctor,
  calendar,
  getReligiousHolidays,
  timeZone,
  now = new Date()
}) {
  const currentDate = getLocalDateParts(now, timeZone);
  const currentDateKey = formatDateKey(currentDate);
  const targetYears = [currentDate.year, currentDate.year + 1];
  const holidays = targetYears.flatMap((year) => getReligiousHolidays(doctorProfile.religion, year))
    .filter(({ date }) => date >= currentDateKey);
  const desiredEvents = holidays.map((holiday) => ({
    ...holiday,
    eventId: `doctorbot${crypto.createHash('sha256')
      .update(`${doctorProfile.doctorId}:${doctorProfile.religion}:${holiday.date}:${holiday.name}`)
      .digest('hex')}`
  }));
  const desiredEventIds = new Set(desiredEvents.map(({ eventId }) => eventId));
  const existingEvents = doctorProfile.religiousHolidayEvents || [];
  const upcomingEvents = existingEvents.filter(({ date }) => date >= currentDateKey);

  for (const event of upcomingEvents) {
    if (desiredEventIds.has(event.eventId)) continue;
    try {
      await calendar.events.delete({
        calendarId: doctorProfile.googleCalendarId || 'primary',
        eventId: event.eventId
      });
    } catch (error) {
      if (error.code !== 404 && error.response?.status !== 404) throw error;
    }
  }

  const existingEventIds = new Set(existingEvents.map(({ eventId }) => eventId));
  for (const event of desiredEvents) {
    if (existingEventIds.has(event.eventId)) continue;
    const [year, month, day] = event.date.split('-').map(Number);
    const endDate = formatDateKey(addDays({ year, month, day }, 1));
    try {
      await calendar.events.insert({
        calendarId: doctorProfile.googleCalendarId || 'primary',
        requestBody: {
          id: event.eventId,
          summary: `${doctorProfile.clinicName} closed: ${event.name}`,
          description: `Clinic closure for ${event.name}. This event is maintained by DoctorBot.`,
          start: { date: event.date },
          end: { date: endDate },
          extendedProperties: { private: { doctorBotReligiousHoliday: 'true', doctorId: doctorProfile.doctorId } }
        }
      });
    } catch (error) {
      if (error.code !== 409 && error.response?.status !== 409) throw error;
    }
  }

  const savedEvents = [
    ...existingEvents.filter(({ date }) => date < currentDateKey),
    ...desiredEvents.map(({ eventId, date }) => ({ eventId, date, religion: doctorProfile.religion }))
  ];
  await Doctor.updateOne({ doctorId: doctorProfile.doctorId, isActive: true }, {
    $set: { religiousHolidayEvents: savedEvents }
  });
  return savedEvents;
}

module.exports = { syncReligiousHolidayEvents };