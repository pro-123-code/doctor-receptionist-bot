require('dotenv').config();

const express = require('express');
const { google } = require('googleapis');
const twilio = require('twilio');

const app = express();
const port = Number.parseInt(process.env.PORT || '3000', 10);
const conversations = new Map();
const bookingLocks = new Map();
const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
const timeZone = process.env.GOOGLE_TIME_ZONE || 'UTC';
const appointmentDurationMinutes = Number.parseInt(
  process.env.APPOINTMENT_DURATION_MINUTES || '30',
  10
);
const appointmentLookaheadDays = Number.parseInt(
  process.env.APPOINTMENT_LOOKAHEAD_DAYS || '7',
  10
);
const officeStartHour = Number.parseInt(process.env.OFFICE_START_HOUR || '9', 10);
const officeEndHour = Number.parseInt(process.env.OFFICE_END_HOUR || '17', 10);
const maxInputLength = 500;
const maxNameLength = 100;
const maxPhoneLength = 30;
const maxSymptomsLength = 500;
const conversationTtlMs = 30 * 60 * 1000;

const conversationSteps = {
  name: {
    next: 'contactNumber',
    reply: 'Thanks, {name}. What is the best contact number for you?'
  },
  contactNumber: {
    next: 'majorSymptoms',
    reply: 'Thank you. What are the main symptoms or reason for your visit?'
  },
  majorSymptoms: {
    next: 'calendarSelection'
  }
};

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port number');
}

if (
  !Number.isInteger(appointmentDurationMinutes) ||
  appointmentDurationMinutes < 15 ||
  !Number.isInteger(appointmentLookaheadDays) ||
  appointmentLookaheadDays < 1 ||
  !Number.isInteger(officeStartHour) ||
  !Number.isInteger(officeEndHour) ||
  officeStartHour < 0 ||
  officeEndHour > 24 ||
  officeStartHour >= officeEndHour
) {
  throw new Error('Invalid appointment or office-hours configuration');
}

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' });
});

function isValidTwilioRequest(request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = request.get('X-Twilio-Signature');
  const baseUrl = (process.env.WEBHOOK_BASE_URL || `${request.protocol}://${request.get('host')}`)
    .replace(/\/$/, '');
  const requestUrl = `${baseUrl}${request.originalUrl}`;

  return Boolean(
    authToken &&
    signature &&
    twilio.validateRequest(authToken, signature, requestUrl, request.body)
  );
}

function getCalendarClient() {
  const requiredCredentials = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REFRESH_TOKEN'
  ];
  const missingCredential = requiredCredentials.find((name) => !process.env[name]);

  if (missingCredential) {
    throw new Error(`Missing Google Calendar configuration: ${missingCredential}`);
  }

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth });
}

function getTimeRange() {
  const start = new Date();
  const end = new Date(start);
  end.setDate(end.getDate() + appointmentLookaheadDays);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
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

function buildCandidateSlots(timeMin, timeMax) {
  const slots = [];
  const rangeStart = new Date(timeMin);
  const rangeEnd = new Date(timeMax);
  const startParts = getZonedParts(rangeStart);
  let localDate = { year: startParts.year, month: startParts.month, day: startParts.day };

  for (let dayOffset = 0; dayOffset <= appointmentLookaheadDays; dayOffset += 1) {
    const date = addLocalDays(localDate, dayOffset);
    const noon = zonedDateTimeToUtc(date.year, date.month, date.day, 12, 0);
    const weekdayName = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short'
    }).format(noon);
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName);

    if (weekday > 0 && weekday < 6) {
      for (
        let minutes = officeStartHour * 60;
        minutes + appointmentDurationMinutes <= officeEndHour * 60;
        minutes += appointmentDurationMinutes
      ) {
        const hour = Math.floor(minutes / 60);
        const minute = minutes % 60;
        const start = zonedDateTimeToUtc(date.year, date.month, date.day, hour, minute);
        const end = new Date(start.getTime() + appointmentDurationMinutes * 60 * 1000);

        if (start >= rangeStart && end <= rangeEnd) {
          slots.push({ start, end });
        }
      }
    }
  }

  return slots;
}

function overlaps(slot, busyPeriod) {
  return (
    slot.start < new Date(busyPeriod.end) &&
    slot.end > new Date(busyPeriod.start)
  );
}

function formatSlot(slot, index) {
  const formatted = new Intl.DateTimeFormat('en', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(slot.start);
  return `${index + 1}. ${formatted}`;
}

async function findAvailableSlots() {
  const calendar = getCalendarClient();
  const { timeMin, timeMax } = getTimeRange();
  const freeBusy = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      timeZone,
      items: [{ id: calendarId }]
    }
  });
  const calendarData = freeBusy.data.calendars?.[calendarId];
  if (calendarData?.errors?.length) {
    throw new Error('Google Calendar returned a free/busy error');
  }
  const busyPeriods = calendarData?.busy || [];

  return buildCandidateSlots(timeMin, timeMax).filter(
    (slot) => !busyPeriods.some((busyPeriod) => overlaps(slot, busyPeriod))
  ).slice(0, 8);
}

async function bookAppointment(conversation, slot) {
  const lockKey = `${slot.start.toISOString()}-${slot.end.toISOString()}`;
  const previousLock = bookingLocks.get(lockKey) || Promise.resolve();
  let releaseLock;
  const currentLock = new Promise((resolve) => { releaseLock = resolve; });
  const lockChain = previousLock.then(() => currentLock);
  bookingLocks.set(lockKey, lockChain);

  await previousLock;
  try {
  const calendar = getCalendarClient();
  const { timeMin, timeMax } = getTimeRange();
  const freeBusy = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      timeZone,
      items: [{ id: calendarId }]
    }
  });
  const calendarData = freeBusy.data.calendars?.[calendarId];
  if (calendarData?.errors?.length) {
    throw new Error('Google Calendar returned a free/busy error');
  }
  const busyPeriods = calendarData?.busy || [];

  if (busyPeriods.some((busyPeriod) => overlaps(slot, busyPeriod))) {
    return false;
  }

  await calendar.events.insert({
    calendarId,
    sendUpdates: 'all',
    requestBody: {
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

  return true;
  } finally {
    releaseLock();
    if (bookingLocks.get(lockKey) === lockChain) bookingLocks.delete(lockKey);
  }
}

function validatePatientInput(step, value) {
  if (value.length === 0 || value.length > maxInputLength) return false;
  if (step === 'name') return value.length <= maxNameLength && /^[\p{L} .'-]+$/u.test(value);
  if (step === 'contactNumber') {
    return value.length <= maxPhoneLength && /^\+?[0-9][0-9 ()-]{6,28}$/.test(value);
  }
  return value.length <= maxSymptomsLength;
}

function saveCalendarRetry(sender, conversation) {
  conversation.step = 'calendarSelection';
  conversation.slots = [];
  conversation.updatedAt = Date.now();
  conversations.set(sender, conversation);
}

async function handleConversationMessage(sender, message) {
  const normalizedMessage = message.trim();

  if (/^(restart|start over)$/i.test(normalizedMessage)) {
    conversations.delete(sender);
    return 'Of course. May I start with your name?';
  }

  let conversation = conversations.get(sender);
  if (conversation && Date.now() - conversation.updatedAt > conversationTtlMs) {
    conversations.delete(sender);
    conversation = undefined;
  }
  conversation = conversation || {
    step: 'name',
    details: {},
    updatedAt: Date.now()
  };
  if (conversation.step === 'calendarSelection') {
    if (!conversation.slots?.length) {
      try {
        const availableSlots = await findAvailableSlots();
        if (!availableSlots.length) return 'I am sorry, there are no available appointments right now.';
        conversation.slots = availableSlots;
        conversation.updatedAt = Date.now();
        conversations.set(sender, conversation);
        return 'Please choose a time:\n' + availableSlots.map(formatSlot).join('\n');
      } catch (error) {
        console.error('Calendar availability error:', error);
        return 'I am still having trouble checking times. Please reply again shortly.';
      }
    }

    if (!/^\d+$/.test(normalizedMessage)) {
      return 'Please reply with the number of one of the slots listed above.';
    }
    const selectedIndex = Number(normalizedMessage) - 1;
    const selectedSlot = conversation.slots?.[selectedIndex];

    if (!selectedSlot) {
      return 'Please reply with the number of one of the slots listed above.';
    }

    const booked = await bookAppointment(conversation, {
      start: new Date(selectedSlot.start),
      end: new Date(selectedSlot.end)
    });

    if (!booked) {
      try {
        conversation.step = 'calendarSelection';
        conversation.slots = await findAvailableSlots();
        if (!conversation.slots.length) {
          conversations.delete(sender);
          return 'That slot was just taken, and there are no other times available right now.';
        }
        conversation.updatedAt = Date.now();
        conversations.set(sender, conversation);
        return 'That slot was just taken. Please choose another:\n' +
          conversation.slots.map(formatSlot).join('\n');
      } catch (error) {
        console.error('Calendar refresh error:', error);
        saveCalendarRetry(sender, conversation);
        return 'That slot was just taken. I am having trouble refreshing times. Please reply again shortly.';
      }
    }

    conversations.delete(sender);
    return 'You are booked. We look forward to seeing you soon.';
  }

  const currentStep = conversationSteps[conversation.step];

  if (!validatePatientInput(conversation.step, normalizedMessage)) {
    if (conversation.step === 'name') return 'Please share your name using letters only (up to 100 characters).';
    if (conversation.step === 'contactNumber') return 'Please share a valid phone number, including country code if possible.';
    return 'Please keep your symptom description under 500 characters.';
  }

  conversation.details[conversation.step] = normalizedMessage;
  conversation.step = currentStep.next;
  conversation.updatedAt = Date.now();

  if (conversation.step === 'calendarSelection') {
    let availableSlots;
    try {
      availableSlots = await findAvailableSlots();
    } catch (error) {
      console.error('Calendar availability error:', error);
      saveCalendarRetry(sender, conversation);
      return 'I am having trouble checking times right now. Please reply again shortly.';
    }

    if (availableSlots.length === 0) {
      conversations.delete(sender);
      return 'I am sorry, there are no available appointments right now. Our team will be in touch.';
    }

    conversation.slots = availableSlots;
    conversations.set(sender, conversation);
    return 'Thanks, ' + conversation.details.name + '. Please choose a time:\n' +
      availableSlots.map(formatSlot).join('\n');
  }

  conversations.set(sender, conversation);

  return currentStep.reply.replace('{name}', conversation.details.name || normalizedMessage);
}

app.post('/webhooks/whatsapp', async (request, response) => {
  if (!isValidTwilioRequest(request)) {
    return response.status(403).json({ error: 'Invalid webhook signature' });
  }

  const incomingMessage = request.body.Body?.trim();
  const sender = request.body.From;

  if (!incomingMessage || !sender) {
    return response.status(400).json({ error: 'Body and From are required' });
  }

  console.log(`WhatsApp message received from ${sender}`);

  const twiml = new twilio.twiml.MessagingResponse();
  try {
    twiml.message(await handleConversationMessage(sender, incomingMessage));
  } catch (error) {
    console.error('WhatsApp conversation error:', error);
    twiml.message('I am sorry, I cannot check appointments right now. Please try again shortly.');
  }

  return response.type('text/xml').send(twiml.toString());
});
// Google Sheet mein appointment save karne ka function
async function saveAppointmentToSheet(patientData) {
    const googleScriptURL = 'YAHAN_APNA_WOH_COPIED_URL_PASTE_KAREIN'; // Isko hata kar apna Google Web App URL yahan daalein
    
    try {
        const response = await axios.post(googleScriptURL, {
            name: patientData.name,
            phone: patientData.phone,
            date: patientData.date,
            time: patientData.time,
            symptoms: patientData.symptoms
        });
        console.log('Appointment saved to Google Sheet successfully:', response.data);
    } catch (error) {
        console.error('Error saving to sheet:', error);
    }
}
app.use((_request, response) => {
  response.status(404).json({ error: 'Not found' });
});

app.listen(port, () => {
  console.log(`Doctor receptionist webhook listening on port ${port}`);
});
