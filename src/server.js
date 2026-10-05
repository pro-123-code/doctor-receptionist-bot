require('dotenv').config();
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { google } = require('googleapis');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const mongoose = require('mongoose');
const { Appointment, connectDatabase, deleteConversation, Doctor, getConversation, recordServiceLog, saveConversation } = require('./models');
const { extractPatientField, extractSlotNumber } = require('./gemini');
const { getLocalDateParts, getLocalDayBounds, parseRequestedDate } = require('./dateParser');
const { mountDashboard } = require('./dashboard');
const { startDailyReport } = require('./cronJobs');
const { getCalendarErrorDetails } = require('./calendarErrors');
const { getWelcomeMessage } = require('./greetings');
const { decryptJson } = require('./secretBox');
const { isClinicOpenOnDate } = require('./clinicSchedule');

const app = express();
app.set('trust proxy', 1);
const port = Number.parseInt(process.env.PORT || '3000', 10);
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
const bookingLocks = new Map();
const conversationLocks = new Map();
const activeReminders = new Map();
const whatsappSockets = new Map();
const whatsappConnectionStates = new Map();
const startingDoctorIds = new Set();

const clinicId = process.env.CLINIC_ID || process.env.DOCTOR_ID;
const doctorId = process.env.DOCTOR_ID || clinicId;
const timeZone = 'Asia/Karachi';
const appointmentDurationMinutes = Number.parseInt(process.env.APPOINTMENT_DURATION_MINUTES || '30', 10);
const appointmentLookaheadDays = Number.parseInt(process.env.APPOINTMENT_LOOKAHEAD_DAYS || '7', 10);
const officeStartHour = Number.parseInt(process.env.OFFICE_START_HOUR || '9', 10);
const officeEndHour = Number.parseInt(process.env.OFFICE_END_HOUR || '17', 10);
const maxInputLength = 500;
const maxNameLength = 100;
const maxPhoneLength = 30;
const maxSymptomsLength = 500;
const conversationTtlMs = 30 * 60 * 1000;

const conversationSteps = {
  name: { next: 'contactNumber', reply: 'Shukriya, {name}. Aap ka behtareen contact number kya hai?' },
  contactNumber: { next: 'majorSymptoms', reply: 'Bohat shukriya. Aap ki visit ki bunyadi wajah ya alamat kya hain?' },
  majorSymptoms: { next: 'appointmentDate', reply: 'Shukriya. Aap kis tareekh ko appointment lena chahenge? Misal: kal, next Friday, ya 25th October.' },
  appointmentDate: { next: 'calendarSelection' }
};

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port number');
}

if (!doctorId || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(doctorId)) {
  throw new Error('DOCTOR_ID must be a 3-64 character lowercase slug');
}

if (process.env.GOOGLE_TIME_ZONE && process.env.GOOGLE_TIME_ZONE !== timeZone) {
  throw new Error('GOOGLE_TIME_ZONE must be Asia/Karachi');
}

if (
  !Number.isInteger(appointmentDurationMinutes) || appointmentDurationMinutes < 15 ||
  !Number.isInteger(appointmentLookaheadDays) || appointmentLookaheadDays < 1 ||
  !Number.isInteger(officeStartHour) || !Number.isInteger(officeEndHour) ||
  officeStartHour < 0 || officeEndHour > 24 || officeStartHour >= officeEndHour
) {
  throw new Error('Invalid appointment or office-hours configuration');
}



app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/health', (_request, response) => {
  const databaseReady = mongoose.connection.readyState === 1;
  response.status(databaseReady ? 200 : 503).json({ status: databaseReady ? 'ok' : 'degraded' });
});

app.get('/dashboard.webmanifest', (_request, response) => {
  response.sendFile(path.join(__dirname, 'dashboard.webmanifest'));
});
app.get('/dashboard-icon.svg', (_request, response) => {
  response.type('image/svg+xml').sendFile(path.join(__dirname, 'dashboard-icon.svg'));
});
app.get('/dashboard-sw.js', (_request, response) => {
  response.type('application/javascript').sendFile(path.join(__dirname, 'dashboard-sw.js'));
});

mountDashboard(app, Appointment, timeZone, doctorId, {
  startWhatsAppConnection: connectDoctorWhatsApp,
  getWhatsAppConnectionStatus
});

function logServiceError(operation, error, sensitiveValues = [], targetDoctorId = doctorId) {
  const isCalendarOperation = /^Calendar\b/.test(operation);
  const details = isCalendarOperation
    ? getCalendarErrorDetails(error)
    : { message: '', status: undefined, code: error?.code };
  const { status, code } = details;
  let message = details.message;
  for (const value of sensitiveValues) {
    if (typeof value === 'string' && value.length >= 3) {
      message = message.split(value).join('[PATIENT DATA REDACTED]');
    }
  }
  const statusLabel = status ? ` HTTP ${status}` : '';
  const codeLabel = code ? ` [${code}]` : '';
  const messageLabel = message ? `: ${message}` : '';
  console.error(`${operation} failed (${error?.name || 'Error'})${statusLabel}${codeLabel}${messageLabel}`);
  recordServiceLog(operation, code, targetDoctorId);
}

function getCalendarClient(doctorProfile) {
  const storedCredentials = doctorProfile.googleCredentialsEncrypted
    ? decryptJson(doctorProfile.googleCredentialsEncrypted)
    : doctorProfile.doctorId === doctorId
      ? {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        refreshToken: process.env.GOOGLE_REFRESH_TOKEN
      }
      : null;
  const credentials = {
    clientId: storedCredentials?.clientId || process.env.GOOGLE_CLIENT_ID,
    clientSecret: storedCredentials?.clientSecret || process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: storedCredentials?.refreshToken
  };
  const missingCredential = !credentials.clientId ? 'GOOGLE_CLIENT_ID' :
    !credentials.clientSecret ? 'GOOGLE_CLIENT_SECRET' :
      !credentials.refreshToken ? 'GOOGLE_REFRESH_TOKEN' : null;
  if (missingCredential) throw new Error(`Missing Google Calendar configuration: ${missingCredential}`);

  const auth = new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret
  );
  auth.setCredentials({ refresh_token: credentials.refreshToken });
  return google.calendar({ version: 'v3', auth });
}

function getTimeRange(requestedDate) {
  if (requestedDate) {
    const dateParts = typeof requestedDate === 'string'
      ? requestedDate.split('-').map(Number).reduce((parts, value, index) => {
        parts[['year', 'month', 'day'][index]] = value;
        return parts;
      }, {})
      : requestedDate;
    const bounds = getLocalDayBounds(dateParts, timeZone);
    return { timeMin: bounds.start.toISOString(), timeMax: bounds.end.toISOString() };
  }

  const start = new Date();
  const end = new Date(start.getTime() + appointmentLookaheadDays * 24 * 60 * 60 * 1000);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

function isGreeting(message) {
  return /^(assalam(?:-?o-?alaikum| alaikum)|salam)[!.\s]*$/i.test(message.trim());
}

function isFacilityQuestion(message) {
  return /\b(facilit(?:y|ies)|services?|treatments?|consultations?|what tests|which tests|do you (?:have|offer)|available at (?:the )?clinic)\b/i.test(message);
}

function getZonedParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(
    parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, Number(value)])
  );
}

function zonedDateTimeToUtc(year, month, day, hour, minute) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const actual = getZonedParts(new Date(utcGuess));
  const actualAsUtc = Date.UTC(
    actual.year,
    actual.month - 1,
    actual.day,
    actual.hour,
    actual.minute,
    actual.second
  );
  return new Date(utcGuess + (utcGuess - actualAsUtc));
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function buildCandidateSlots(timeMin, timeMax, doctorProfile) {
  const slots = [];
  const rangeStart = new Date(timeMin);
  const rangeEnd = new Date(timeMax);
  const startParts = getZonedParts(rangeStart);
  let localDate = { year: startParts.year, month: startParts.month, day: startParts.day };

  for (let dayOffset = 0; dayOffset <= appointmentLookaheadDays; dayOffset += 1) {
    const date = addLocalDays(localDate, dayOffset);
    const noon = zonedDateTimeToUtc(date.year, date.month, date.day, 12, 0);
    const weekdayName = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(noon);
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName);

    if (isClinicOpenOnDate(date, doctorProfile)) {
      for (
        let minutes = officeStartHour * 60;
        minutes + appointmentDurationMinutes <= officeEndHour * 60;
        minutes += appointmentDurationMinutes
      ) {
        const hour = Math.floor(minutes / 60);
        const minute = minutes % 60;
        const start = zonedDateTimeToUtc(date.year, date.month, date.day, hour, minute);
        const end = new Date(start.getTime() + appointmentDurationMinutes * 60 * 1000);

        if (start >= rangeStart && start > new Date() && end <= rangeEnd) {
          slots.push({ start, end });
        }
      }
    }
  }
  return slots;
}

function overlaps(slot, busyPeriod) {
  return (
    slot.start < new Date(busyPeriod.end) && slot.end > new Date(busyPeriod.start)
  );
}

function formatSlot(slot, index) {
  const parts = getZonedParts(slot.start);
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(slot.start)
  );
  const weekdayNames = ['Itwaar', 'Peer', 'Mangal', 'Budh', 'Jumerat', 'Jumma', 'Hafta'];
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const hour = parts.hour % 12 || 12;
  const meridiem = parts.hour >= 12 ? 'PM' : 'AM';
  const formatted = `${weekdayNames[weekdayIndex]}, ${parts.day} ${monthNames[parts.month - 1]} ${hour}:${String(parts.minute).padStart(2, '0')} ${meridiem}`;
  return `${index + 1}. ${formatted} (${timeZone})`;
}

// Timeout wrap function taake Google API network hang hone par crash ya infinite timeout na ho
async function executeWithTimeout(promiseFunction, timeoutMs = 10000) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Google Calendar API request timed out'));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promiseFunction(), timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

async function getBusyPeriods(timeMin, timeMax, doctorProfile) {
  const calendarId = doctorProfile.googleCalendarId || 'primary';
  let freeBusy;
  try {
    const calendar = getCalendarClient(doctorProfile);
    freeBusy = await executeWithTimeout(async () => {
      return await calendar.freebusy.query({
        requestBody: { timeMin, timeMax, timeZone, items: [{ id: calendarId }] }
      });
    }, 12000); // 12 seconds max timeout
  } catch (error) {
    throw new Error('Google Calendar free/busy query failed', { cause: error });
  }

  const calendarData = freeBusy.data?.calendars?.[calendarId];
  if (!calendarData) {
    throw new Error(`Google Calendar was not returned: ${calendarId}`);
  }
  if (calendarData.errors?.length) {
    const calendarError = calendarData.errors
      .map(({ domain, reason }) => [domain, reason].filter(Boolean).join(': '))
      .join(', ');
    throw new Error(`Google Calendar free/busy error: ${calendarError}`);
  }

  return { busyPeriods: Array.isArray(calendarData.busy) ? calendarData.busy : [] };
}

async function findAvailableSlots(requestedDate, doctorProfile) {
  if (requestedDate) {
    const dateParts = typeof requestedDate === 'string'
      ? requestedDate.split('-').map(Number).reduce((parts, value, index) => {
        parts[['year', 'month', 'day'][index]] = value;
        return parts;
      }, {})
      : requestedDate;
    if (!isClinicOpenOnDate(dateParts, doctorProfile)) return [];
  }
  const { timeMin, timeMax } = getTimeRange(requestedDate);
  const { busyPeriods } = await getBusyPeriods(timeMin, timeMax, doctorProfile);

  return buildCandidateSlots(timeMin, timeMax, doctorProfile).filter(
    (slot) => !busyPeriods.some((busyPeriod) => overlaps(slot, busyPeriod))
  ).slice(0, 8);
}

function scheduleAppointmentReminder(doctorProfile, sender, slot, patientName) {
  const reminderKey = `${doctorProfile.doctorId}:${sender}:${slot.start.toISOString()}`;
  const reminderTime = new Date(slot.start.getTime() - 2 * 60 * 60 * 1000);
  const delay = Math.max(0, reminderTime.getTime() - Date.now());

  if (slot.start.getTime() > Date.now()) {
    const previousTimer = activeReminders.get(reminderKey);
    if (previousTimer) clearTimeout(previousTimer);
    const timerId = setTimeout(async () => {
      const socket = whatsappSockets.get(doctorProfile.doctorId);
      const doctorIsActive = await Doctor.exists({ doctorId: doctorProfile.doctorId, isActive: true });
      if (socket && doctorIsActive) {
        try {
          await socket.sendMessage(sender, {
            text: `Reminder: Salam ${patientName}! Aap ki appointment aaj waqt par hai (${slot.start.toLocaleString('en-PK', { timeZone })}). Hum aap ke muntazir hain.`
          });
          console.log('Appointment reminder sent');
        } catch (err) {
          logServiceError('Appointment reminder', err, [], doctorProfile.doctorId);
        }
      }
      activeReminders.delete(reminderKey);
    }, delay);

    activeReminders.set(reminderKey, timerId);
    console.log(`Appointment reminder scheduled for ${reminderTime.toISOString()}`);
  }
}

async function restoreAppointmentReminders(doctorProfile) {
  const appointments = await Appointment.find({
    doctorId: doctorProfile.doctorId,
    status: 'booked',
    slotStart: { $gt: new Date() }
  }).lean();

  for (const appointment of appointments) {
    scheduleAppointmentReminder(
      doctorProfile,
      appointment.senderJid,
      { start: appointment.slotStart, end: appointment.slotEnd },
      appointment.details.name
    );
  }
}

async function bookAppointment(conversation, slot, doctorProfile) {
  const doctorId = doctorProfile.doctorId;
  const lockKey = `${doctorId}:${slot.start.toISOString()}-${slot.end.toISOString()}`;
  const previousLock = bookingLocks.get(lockKey) || Promise.resolve();
  let releaseLock;
  const currentLock = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const lockChain = previousLock.then(() => currentLock);
  bookingLocks.set(lockKey, lockChain);

  await previousLock;
  let reservation;
  let calendarEvent;
  let calendarInsertStarted = false;
  try {
    doctorProfile = await Doctor.findOne({ doctorId, isActive: true })
      .select('+googleCredentialsEncrypted').lean();
    if (!doctorProfile || !doctorProfile.setupComplete) return false;
    if (slot.start <= new Date()) return false;
    if (!isClinicOpenOnDate(getLocalDateParts(slot.start, timeZone), doctorProfile)) {
      const error = new Error('Clinic is closed on selected date');
      error.code = 'CLINIC_CLOSED';
      throw error;
    }

    const existingReservation = await Appointment.findOne({ doctorId, slotKey: lockKey });
    if (existingReservation?.status === 'pending' && existingReservation.expiresAt <= new Date()) {
      await Appointment.deleteOne({ _id: existingReservation._id, doctorId, status: 'pending' });
    } else if (existingReservation) {
      return false;
    }

    try {
      reservation = await Appointment.create({
        doctorId,
        clinicId: doctorId,
        slotKey: lockKey,
        senderJid: conversation.senderJid,
        details: conversation.details,
        slotStart: slot.start,
        slotEnd: slot.end,
        status: 'pending',
        expiresAt: new Date(Date.now() + 2 * 60 * 1000)
      });
    } catch (error) {
      if (error.code === 11000) return false;
      throw error;
    }

    const calendar = getCalendarClient(doctorProfile);
    const doctorCalendarId = doctorProfile.googleCalendarId || 'primary';
    const { timeMin, timeMax } = getTimeRange(getLocalDateParts(slot.start, timeZone));
    const { busyPeriods } = await getBusyPeriods(timeMin, timeMax, doctorProfile);

    if (busyPeriods.some((busyPeriod) => overlaps(slot, busyPeriod))) {
      await Appointment.deleteOne({ _id: reservation._id, doctorId });
      return false;
    }
    const currentDoctor = await Doctor.findOne({ doctorId, isActive: true })
      .select('workingDays offDays setupComplete').lean();
    if (!currentDoctor || !currentDoctor.setupComplete) {
      await Appointment.deleteOne({ _id: reservation._id, doctorId });
      return false;
    }
    if (!isClinicOpenOnDate(getLocalDateParts(slot.start, timeZone), currentDoctor)) {
      await Appointment.deleteOne({ _id: reservation._id, doctorId });
      const error = new Error('Clinic is closed on selected date');
      error.code = 'CLINIC_CLOSED';
      throw error;
    }
    if (!await Doctor.exists({ doctorId, isActive: true })) {
      await Appointment.deleteOne({ _id: reservation._id, doctorId });
      return false;
    }

    calendarInsertStarted = true;
    try {
      calendarEvent = await executeWithTimeout(async () => {
        return await calendar.events.insert({
          calendarId: doctorCalendarId,
          sendUpdates: 'all',
          requestBody: {
            id: crypto.createHash('sha256').update(`${doctorId}:${doctorCalendarId}:${lockKey}`).digest('hex'),
            summary: `Patient appointment: ${conversation.details.name}`,
            description: [
              `Name: ${conversation.details.name}`,
              `Contact: ${conversation.details.contactNumber}`,
              `Symptoms: ${conversation.details.majorSymptoms}`
            ].join('\n'),
            start: { dateTime: slot.start.toISOString(), timeZone },
            end: { dateTime: slot.end.toISOString(), timeZone }
          }
        });
      }, 12000);
    } catch (error) {
      if (error.code === 409 || error.response?.status === 409) {
        await Appointment.deleteOne({ _id: reservation._id, doctorId });
        return false;
      }
      throw error;
    }

    if (!await Doctor.exists({ doctorId, isActive: true })) {
      try {
        await calendar.events.delete({
          calendarId: doctorCalendarId,
          eventId: calendarEvent.data.id
        });
      } catch (error) {
        logServiceError('Calendar booking cancellation', error, Object.values(conversation.details), doctorId);
      }
      await Appointment.deleteOne({ _id: reservation._id, doctorId });
      return false;
    }

    await Appointment.updateOne(
      { _id: reservation._id, doctorId },
      { $set: { status: 'booked', bookedAt: new Date(), calendarEventId: calendarEvent.data.id }, $unset: { expiresAt: 1 } },
      { runValidators: true }
    );

    scheduleAppointmentReminder(doctorProfile, conversation.senderJid, slot, conversation.details.name);
    return true;
  } catch (error) {
    if (reservation && !calendarEvent && !calendarInsertStarted) {
      await Appointment.deleteOne({ _id: reservation._id, doctorId });
    }
    throw error;
  } finally {
    releaseLock();
    if (bookingLocks.get(lockKey) === lockChain) bookingLocks.delete(lockKey);
  }
}

function validatePatientInput(step, value) {
  if (value.length === 0 || value.length > maxInputLength) return false;
  if (step === 'name') return value.length <= maxNameLength && /^[\p{L} .'-]+$/u.test(value);
  if (step === 'contactNumber') {
    return value.length <= maxPhoneLength && /^\+?[0-9 ()-]{6,28}$/.test(value);
  }
  return value.length <= maxSymptomsLength;
}

function getClinicClosedReply(dateParts, doctorProfile) {
  const localDate = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, 12));
  const formattedDate = new Intl.DateTimeFormat('en-PK', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone
  }).format(localDate);
  return `Maazrat, ${doctorProfile.clinicName} ${formattedDate} ko band hai. Meherbani karke kisi aur working day ki tareekh batayein.`;
}

async function saveCalendarRetry(sender, conversation, doctorId) {
  conversation.step = 'calendarSelection';
  conversation.slots = [];
  conversation.updatedAt = Date.now();
  await saveConversation(sender, conversation, doctorId);
}

async function handleConversationMessage(sender, message, doctorProfile) {
  const normalizedMessage = message.trim();
  doctorProfile = await Doctor.findOne({ doctorId: doctorProfile.doctorId, isActive: true })
    .select('+googleCredentialsEncrypted').lean();
  if (!doctorProfile) return null;
  const targetDoctorId = doctorProfile.doctorId;

  const welcomeMessage = () => getWelcomeMessage(normalizedMessage, doctorProfile);

  if (/^(restart|start over)$/i.test(normalizedMessage)) {
    await deleteConversation(sender, targetDoctorId);
    const restartedConversation = {
      step: 'name',
      details: {},
      senderJid: sender,
      updatedAt: Date.now()
    };
    await saveConversation(sender, restartedConversation, targetDoctorId);
    return welcomeMessage();
  }

  let conversation = await getConversation(sender, targetDoctorId);
  if (conversation && Date.now() - conversation.updatedAt > conversationTtlMs) {
    await deleteConversation(sender, targetDoctorId);
    conversation = undefined;
  }
  if (!conversation) {
    conversation = { step: 'name', details: {}, senderJid: sender, updatedAt: Date.now() };
    await saveConversation(sender, conversation, targetDoctorId);
    return welcomeMessage();
  }
  conversation.senderJid = sender;

  if (isGreeting(normalizedMessage)) return welcomeMessage();
  if (isFacilityQuestion(normalizedMessage)) {
    const facilities = doctorProfile.facilitiesList.join(', ');
    const services = doctorProfile.servicesList?.length
      ? ` Hamari services aur treatments: ${doctorProfile.servicesList.join(', ')}.`
      : '';
    const consultation = doctorProfile.consultationDetails?.trim()
      ? ` ${doctorProfile.consultationDetails.trim()}`
      : '';
    return `${doctorProfile.doctorName} ke ${doctorProfile.clinicName} mein ${facilities} ki sahuliyaat mojood hain.${services}${consultation}`;
  }

  if (conversation.step === 'calendarSelection') {
    if (!conversation.slots?.length) {
      try {
        const availableSlots = await findAvailableSlots(conversation.requestedDate, doctorProfile);
        if (!availableSlots.length) {
          conversation.step = 'appointmentDate';
          conversation.requestedDate = undefined;
          await saveConversation(sender, conversation, targetDoctorId);
          return 'Maazrat, us tareekh ko koi waqt dastiyab nahi. Meherbani karke doosri tareekh batayein.';
        }
        conversation.slots = availableSlots;
        conversation.updatedAt = Date.now();
        await saveConversation(sender, conversation, targetDoctorId);
        return 'Meherbani karke neeche diye gaye auqaat mein se ek muntakhib karein:\n' +
          availableSlots.map(formatSlot).join('\n') + '\n\nSirf slot ka number reply karein.';
      } catch (error) {
        logServiceError('Calendar availability', error, [], targetDoctorId);
        return 'Maazrat, waqt check karne mein mushkil aa rahi hai. Meherbani karke thori dair baad dobara reply karein.';
      }
    }

    let selectedSlotNumber = /^\d+$/.test(normalizedMessage) ? Number(normalizedMessage) : null;
    if (selectedSlotNumber === null) {
      if (normalizedMessage.length > maxInputLength) {
        return 'Meherbani karke upar diye gaye kisi slot ka number ya waqt reply karein.';
      }
      try {
        selectedSlotNumber = await extractSlotNumber(normalizedMessage, conversation.slots, formatSlot, doctorProfile);
      } catch (error) {
        logServiceError('Gemini appointment selection', error, [], targetDoctorId);
      }
    }
    if (!Number.isInteger(selectedSlotNumber) || selectedSlotNumber < 1) {
      return 'Meherbani karke upar diye gaye kisi slot ka number ya waqt reply karein.';
    }
    const selectedIndex = selectedSlotNumber - 1;
    const selectedSlot = conversation.slots?.[selectedIndex];

    if (!selectedSlot) {
      return 'Yeh slot number durust nahi hai. Meherbani karke upar diye gaye kisi slot ka number reply karein.';
    }

    let booked;
    try {
      booked = await bookAppointment(conversation, {
        start: new Date(selectedSlot.start),
        end: new Date(selectedSlot.end)
      }, doctorProfile);
    } catch (error) {
      if (error.code === 'CLINIC_CLOSED') {
        conversation.step = 'appointmentDate';
        conversation.requestedDate = undefined;
        conversation.slots = [];
        await saveConversation(sender, conversation, targetDoctorId);
        return getClinicClosedReply(getLocalDateParts(selectedSlot.start, timeZone), doctorProfile);
      }
      logServiceError('Calendar booking', error, Object.values(conversation.details), targetDoctorId);
      await saveCalendarRetry(sender, conversation, targetDoctorId);
      return 'Maazrat, appointment save karne mein mushkil aa gayi. Meherbani karke thori dair baad dobara reply karein.';
    }

    if (!booked) {
      try {
        conversation.step = 'calendarSelection';
        conversation.slots = await findAvailableSlots(conversation.requestedDate, doctorProfile);
        if (!conversation.slots.length) {
          await deleteConversation(sender, targetDoctorId);
          return 'Maazrat, woh waqt abhi kisi aur ne le liya hai aur is waqt koi doosra waqt dastiyab nahi hai.';
        }
        conversation.updatedAt = Date.now();
        await saveConversation(sender, conversation, targetDoctorId);
        return 'Maazrat, woh waqt abhi kisi aur ne le liya hai. Meherbani karke doosra waqt muntakhib karein:\n' +
          conversation.slots.map(formatSlot).join('\n') + '\n\nSirf slot ka number reply karein.';
      } catch (error) {
        logServiceError('Calendar refresh', error, [], targetDoctorId);
        await saveCalendarRetry(sender, conversation, targetDoctorId);
        return 'Woh waqt abhi kisi aur ne le liya hai. Auqaat dobara check karne mein mushkil aa rahi hai; meherbani karke thori dair baad reply karein.';
      }
    }

    await deleteConversation(sender, targetDoctorId);
    return 'Aap ki appointment kamyabi se book ho gayi hai. Hum jald aap se mulaqat ke muntazir hain.';
  }

  if (conversation.step === 'appointmentDate') {
    if (normalizedMessage.length > maxInputLength) {
      return `Meherbani karke ${maxInputLength} characters se chhoti tareekh bhejein.`;
    }
    const requestedDate = parseRequestedDate(normalizedMessage, timeZone, appointmentLookaheadDays);
    if (!requestedDate) {
      return `Maazrat, tareekh samajh nahi aayi. Aaj se agle ${appointmentLookaheadDays} din ke andar koi tareekh batayein, misal: kal ya next Friday.`;
    }

    if (!isClinicOpenOnDate(requestedDate, doctorProfile)) {
      return getClinicClosedReply(requestedDate, doctorProfile);
    }

    conversation.requestedDate = `${requestedDate.year}-${String(requestedDate.month).padStart(2, '0')}-${String(requestedDate.day).padStart(2, '0')}`;
    let availableSlots;
    try {
      availableSlots = await findAvailableSlots(conversation.requestedDate, doctorProfile);
    } catch (error) {
      logServiceError('Calendar availability', error, [], targetDoctorId);
      await saveConversation(sender, conversation, targetDoctorId);
      return 'Maazrat, waqt check karne mein mushkil aa rahi hai. Meherbani karke thori dair baad dobara reply karein.';
    }

    if (availableSlots.length === 0) {
      conversation.requestedDate = undefined;
      await saveConversation(sender, conversation, targetDoctorId);
      return 'Maazrat, us tareekh ko koi waqt dastiyab nahi. Meherbani karke doosri tareekh batayein.';
    }

    conversation.step = 'calendarSelection';
    conversation.slots = availableSlots;
    conversation.updatedAt = Date.now();
    await saveConversation(sender, conversation, targetDoctorId);
    return `${doctorProfile.doctorName} ke ${doctorProfile.clinicName} mein is tareekh ke dastiyab auqaat yeh hain:\n` +
      availableSlots.map(formatSlot).join('\n') + '\n\nSirf slot ka number reply karein.';
  }

  const currentStep = conversationSteps[conversation.step];
  let extractedValue;
  if (normalizedMessage.length > 0 && normalizedMessage.length <= maxInputLength) {
    try {
      extractedValue = await extractPatientField(conversation.step, normalizedMessage, doctorProfile);
    } catch (error) {
      logServiceError('Gemini field extraction', error, [], targetDoctorId);
    }
  }
  const patientValue = extractedValue && validatePatientInput(conversation.step, extractedValue)
    ? extractedValue
    : normalizedMessage;

  if (!validatePatientInput(conversation.step, patientValue)) {
    if (conversation.step === 'name') return 'Meherbani karke sirf huroof mein apna naam batayein (zyada se zyada 100 huroof).';
    if (conversation.step === 'contactNumber') return 'Meherbani karke durust phone number batayein, mumkin ho to country code ke saath.';
    return 'Meherbani karke alamat ki tafseel 500 characters se kam rakhein.';
  }

  conversation.details[conversation.step] = patientValue;
  conversation.step = currentStep.next;
  conversation.updatedAt = Date.now();

  if (conversation.step === 'calendarSelection') {
    let availableSlots;
    try {
      availableSlots = await findAvailableSlots(undefined, doctorProfile);
    } catch (error) {
      logServiceError('Calendar availability', error, [], targetDoctorId);
      await saveCalendarRetry(sender, conversation, targetDoctorId);
      return 'Maazrat, waqt check karne mein mushkil aa rahi hai. Meherbani karke thori dair baad dobara reply karein.';
    }

    if (availableSlots.length === 0) {
      await deleteConversation(sender, targetDoctorId);
      return 'Maazrat, is waqt koi appointment ka waqt dastiyab nahi hai. Hamari team aap se rabta karegi.';
    }

    conversation.slots = availableSlots;
    await saveConversation(sender, conversation, targetDoctorId);
    return 'Shukriya, ' + conversation.details.name + '. Neeche diye gaye auqaat mein se ek muntakhib karein:\n' +
      availableSlots.map(formatSlot).join('\n') + '\n\nSirf slot ka number reply karein.';
  }

  await saveConversation(sender, conversation, targetDoctorId);
  return currentStep.reply.replace('{name}', conversation.details.name || patientValue);
}

async function handleConversationMessageSerially(sender, message, doctorProfile) {
  const lockKey = `${doctorProfile.doctorId}:${sender}`;
  const previousLock = conversationLocks.get(lockKey) || Promise.resolve();
  let releaseLock;
  const currentLock = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const lockChain = previousLock.then(() => currentLock);
  conversationLocks.set(lockKey, lockChain);

  await previousLock;
  try {
    return await handleConversationMessage(sender, message, doctorProfile);
  } finally {
    releaseLock();
    if (conversationLocks.get(lockKey) === lockChain) conversationLocks.delete(lockKey);
  }
}

function getWhatsAppConnectionStatus(targetDoctorId) {
  return whatsappConnectionStates.get(targetDoctorId) || { status: 'disconnected' };
}

function getWhatsAppAuthDirectory(targetDoctorId) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(targetDoctorId)) {
    throw new Error('Invalid doctor ID for WhatsApp session storage');
  }
  const localDataRoot = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  const configuredRoot = process.env.BAILEYS_AUTH_DIR || path.join(localDataRoot, 'DoctorBot', 'sessions');
  const sessionDirectory = path.resolve(configuredRoot, `doctor_${targetDoctorId}`);
  const legacyDirectory = path.join(__dirname, '..', 'auth_info_baileys', targetDoctorId);
  if (!fs.existsSync(path.join(sessionDirectory, 'creds.json')) &&
    fs.existsSync(path.join(legacyDirectory, 'creds.json'))) {
    return legacyDirectory;
  }
  return sessionDirectory;
}

async function secureWhatsAppAuthDirectory(authDirectory) {
  await fsPromises.mkdir(authDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fsPromises.chmod(authDirectory, 0o700);
}

async function connectDoctorWhatsApp(targetDoctorId) {
  const doctorProfile = await Doctor.findOne({ doctorId: targetDoctorId, isActive: true })
    .select('+googleCredentialsEncrypted').lean();
  if (!doctorProfile) throw new Error('Doctor account is inactive');
  await startDoctorWhatsApp(doctorProfile);
  return getWhatsAppConnectionStatus(targetDoctorId);
}

app.use((_request, response) => {
  response.status(404).json({ error: 'Not found' });
});

async function startDoctorWhatsApp(doctorProfile) {
  const targetDoctorId = doctorProfile.doctorId;
  if (!doctorProfile.isActive || whatsappSockets.has(targetDoctorId) || startingDoctorIds.has(targetDoctorId)) return;
  startingDoctorIds.add(targetDoctorId);
  whatsappConnectionStates.set(targetDoctorId, { status: 'starting' });

  const authDirectory = getWhatsAppAuthDirectory(targetDoctorId);
  let socket;
  let saveCreds;
  try {
    if (!await Doctor.exists({ doctorId: targetDoctorId, isActive: true })) {
      whatsappConnectionStates.set(targetDoctorId, { status: 'disconnected' });
      return;
    }
    await secureWhatsAppAuthDirectory(authDirectory);
    const authState = await useMultiFileAuthState(authDirectory);
    saveCreds = authState.saveCreds;
    socket = makeWASocket({
      auth: authState.state,
      browser: ['Doctor Receptionist', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });
    whatsappSockets.set(targetDoctorId, socket);
  } catch (error) {
    whatsappConnectionStates.set(targetDoctorId, { status: 'error' });
    throw error;
  } finally {
    startingDoctorIds.delete(targetDoctorId);
  }

  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      const state = { status: 'qr', qrDataUrl: null };
      whatsappConnectionStates.set(targetDoctorId, state);
      QRCode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 2, width: 320 })
        .then((qrDataUrl) => {
          if (whatsappConnectionStates.get(targetDoctorId) === state) state.qrDataUrl = qrDataUrl;
        })
        .catch((error) => {
          whatsappConnectionStates.set(targetDoctorId, { status: 'error' });
          logServiceError('WhatsApp QR generation', error, [], targetDoctorId);
        });
    }
    if (connection === 'open') {
      whatsappConnectionStates.set(targetDoctorId, { status: 'connected' });
      console.log(`WhatsApp connection ready for doctor ${doctorProfile.doctorId}.`);
      restoreAppointmentReminders(doctorProfile).catch((error) =>
        logServiceError('Reminder restoration', error, [], doctorProfile.doctorId));
    }
    if (connection === 'close') {
      if (whatsappSockets.get(doctorProfile.doctorId) === socket) {
        whatsappSockets.delete(doctorProfile.doctorId);
      }
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        whatsappConnectionStates.set(targetDoctorId, { status: 'reconnecting' });
        console.log(`WhatsApp connection closed for doctor ${doctorProfile.doctorId}; reconnecting.`);
        setTimeout(() => startDoctorWhatsApp(doctorProfile).catch((error) =>
          logServiceError('WhatsApp reconnect', error, [], doctorProfile.doctorId)), 3000).unref();
      } else {
        whatsappConnectionStates.set(targetDoctorId, { status: 'loggedOut' });
        console.error(`WhatsApp logged out for doctor ${doctorProfile.doctorId}. Re-link that clinic's number.`);
      }
    }
  });

  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      const sender = message.key.remoteJid;
      const incomingMessage = message.message?.conversation ||
        message.message?.extendedTextMessage?.text;

      if (message.key.fromMe || !sender || sender.endsWith('@g.us') || !incomingMessage) {
        continue;
      }

      let reply;
      try {
        reply = await handleConversationMessageSerially(sender, incomingMessage, doctorProfile);
      } catch (error) {
        logServiceError('WhatsApp conversation', error, [], doctorProfile.doctorId);
        reply = 'Maazrat, appointment check karne mein mushkil aa rahi hai. Meherbani karke thori dair baad dobara reply karein.';
      }

      if (!reply) continue;

      try {
        await socket.sendMessage(sender, { text: reply });
      } catch (error) {
        logServiceError('WhatsApp reply', error, [], doctorProfile.doctorId);
      }
    }
  });
}

const doctorReportTasks = new Map();

async function synchronizeDoctorWorkers() {
  const activeDoctors = await Doctor.find({ isActive: true }).select('+googleCredentialsEncrypted').lean();
  const activeDoctorIds = new Set(activeDoctors.map(({ doctorId: activeDoctorId }) => activeDoctorId));

  for (const [connectedDoctorId, socket] of whatsappSockets) {
    if (!activeDoctorIds.has(connectedDoctorId)) {
      whatsappSockets.delete(connectedDoctorId);
      socket.end(new Error('Doctor account deactivated'));
      const reportTask = doctorReportTasks.get(connectedDoctorId);
      if (reportTask) reportTask.stop();
      doctorReportTasks.delete(connectedDoctorId);
    }
  }

  for (const doctorProfile of activeDoctors) {
    if (!whatsappSockets.has(doctorProfile.doctorId)) {
      const authDirectory = getWhatsAppAuthDirectory(doctorProfile.doctorId);
      if (fs.existsSync(path.join(authDirectory, 'creds.json'))) {
        startDoctorWhatsApp(doctorProfile).catch((error) =>
          logServiceError('WhatsApp startup', error, [], doctorProfile.doctorId));
      } else if (!whatsappConnectionStates.has(doctorProfile.doctorId)) {
        whatsappConnectionStates.set(doctorProfile.doctorId, { status: 'disconnected' });
      }
    }
    if (!doctorReportTasks.has(doctorProfile.doctorId)) {
      try {
        const reportTask = startDailyReport(doctorProfile);
        if (reportTask) doctorReportTasks.set(doctorProfile.doctorId, reportTask);
      } catch (error) {
        logServiceError('Daily report scheduler startup', error, [], doctorProfile.doctorId);
      }
    }
  }
}

function startDoctorWorkerSynchronization() {
  synchronizeDoctorWorkers().catch((error) => logServiceError('Doctor worker sync', error));
  const interval = setInterval(() => {
    synchronizeDoctorWorkers().catch((error) => logServiceError('Doctor worker sync', error));
  }, 30_000);
  interval.unref();
}

async function startServer() {
    try {
        await connectDatabase(process.env.MONGODB_URI, clinicId, doctorId);

        app.listen(port, () => {
            console.log(`Doctor receptionist health server listening on port ${port}`);
            startDoctorWorkerSynchronization();
        });
    } catch (error) {
        logServiceError('Server startup', error);
    }
}

// Function ko call karna zaroori hai taake server start ho
startServer();
