// Lets a patient move an appointment they already booked, from WhatsApp.
//
// Kept separate from the conversation handler so the intent and wording rules can
// be tested on their own, and so the change to the live conversation flow is as
// small as possible. Nothing here touches the database; the handler owns that.

// Words a patient is likely to use when they want to change an existing booking,
// in Roman Urdu and Roman English, which is what the rest of the bot replies in.
const CHANGE_INTENT_PATTERN = new RegExp(
  '\\b('
  + 'cancel|cancel?\\s?kar(?:na|do|den)|cancel\\s?karein|rebook|re-?book'
  + '|reschedul(?:e|ing)|dobara\\s?book'
  // An optional possessive is allowed between the verb and the noun, so both
  // "change date" and "change my appointment" are understood.
  + '|change\\s?(?:my|the|it|our)?\\s?(?:date|time|slot|appointment|booking)'
  + '|move\\s?(?:my|the|it|our)?\\s?(?:date|time|slot|appointment|booking)'
  + '|shift\\s?(?:my|the|it|our)?'
  + '|tareekh\\s?badle?in?|waqt\\s?badle?in?|appointment\\s?(?:badle?in?|hatana|nahi)'
  + '|appointment\\s?(?:change|move|cancel|remove)'
  + ')\\b',
  'i'
);

// A patient asking about an appointment is not the same as asking to change one, so
// a bare question must not trigger the flow. These are checked before the pattern.
const INQUIRY_ONLY_PATTERN = /\b(?:meri\s+appointment\s+(?:kab|kitne|kya|time|date|hai|kab\s+hai)|appointment\s+(?:kab|kitne|kya|time|date|hai|kab\s+hai)|confirm|koi\s+appointment)\b/i;

// Steps used by the reschedule flow. They are namespaced so they can never collide
// with the booking steps.
const RESCHEDULE_DATE_STEP = 'rescheduleDate';
const RESCHEDULE_SELECTION_STEP = 'rescheduleSelection';

function wantsToChangeAppointment(message) {
  const text = String(message || '').trim();
  if (!text) return false;
  if (INQUIRY_ONLY_PATTERN.test(text)) return false;
  // Long free text is far more likely to be symptoms than a command.
  if (text.length > 80) return false;
  return CHANGE_INTENT_PATTERN.test(text);
}

function formatRescheduleConfirmation(appointment, timeZone) {
  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone, dateStyle: 'full', timeStyle: 'short'
  }).format(new Date(appointment.slotStart));
  return `Aap ki appointment ${when} par hai${appointment.clinicName ? ` (${appointment.clinicName})` : ''}. `
    + 'Kya aap ise change karna chahte hain?';
}

function formatNoAppointmentReply() {
  return 'Aap ki koi booked appointment is number par nahi mili. '
    + 'Agar aap nayi book karna chahte hain to "appointment" likh kar bhejein.';
}

function formatCancelledReply(when) {
  return `Aap ki appointment ${when} cancel kar di gayi hai. `
    + 'Nayi appointment book karna ho to "appointment" likh kar bhejein.';
}

// Only an appointment that has not happened yet and is still booked can be moved.
// Anything else would rewrite history the clinic has already acted on.
function canReschedule(appointment, now = new Date()) {
  return Boolean(appointment)
    && appointment.status === 'booked'
    && new Date(appointment.slotStart).getTime() > now.getTime();
}

module.exports = {
  CHANGE_INTENT_PATTERN,
  RESCHEDULE_DATE_STEP,
  RESCHEDULE_SELECTION_STEP,
  canReschedule,
  formatCancelledReply,
  formatNoAppointmentReply,
  formatRescheduleConfirmation,
  wantsToChangeAppointment
};