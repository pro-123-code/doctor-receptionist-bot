// Handles what a patient says *after* their appointment has been confirmed.
//
// The booking flow removes the conversation record once a slot is booked. Without
// this layer the next message ("is it confirmed?", "thank you", "ok") is treated
// as a brand new patient and the welcome menu asks for a name all over again.
// The handlers here are pure so the wording and intent rules can be tested on
// their own; the WhatsApp handler owns the database lookup and sending.

const CONFIRMATION_PATTERN = new RegExp(
  '\\b(?:'
  + 'confirm(?:ed|ation)?|pakki|pakka|finali[sz]ed'
  + '|(?:appointment|booking|slot)\\s+(?:book\\s+)?(?:ho|hui|hai|lagi|lag|fix|pakki|pakka|final|booked)'
  + '|(?:appointment|booking|slot)\\s+(?:kab|kya|kahan|kaunse?|kis|time|date|when|where)'
  + '|(?:meri|mera|my)\\s+(?:appointment|booking)\\s+(?:kab|kya|kahan|kaunse?|kis|time|date|when|where|confirm|pakki|pakka|hai|ho|lagi|lag|fix|booked)'
  + '|when\\s+is\\s+my\\s+(?:appointment|booking)'
  + ')\\b',
  'i'
);

const GRATITUDE_PATTERN = /\b(?:thank(?:s|you|u)?|thankyou|thanku|thnx|thx|shukri?ya|shukriyaa|shukria|jazak(?:allah|allahu|allaho)?|jazakallah)\b/i;

// A farewell ends the conversation even when it is mixed with thanks, so it is
// checked before the closing acknowledgements.
const FAREWELL_PATTERN = /\b(?:bye|good\s?bye|goodbye|khuda\s?hafiz|allah\s?hafiz|see\s+you|take\s?care)\b/i;

// Every word in a short message has to be an acknowledgement for it to count as
// a closing message. This keeps "appointment kab hai" and other real questions
// from being read as "okay".
const CLOSING_WORDS = new Set([
  'ok', 'okay', 'okey', 'okie', 'k', 'done', 'theek', 'thik', 'teek', 'hai',
  'acha', 'achha', 'accha', 'haan', 'han', 'ji', 'got', 'it', 'understood',
  'samajh', 'samjh', 'gaya', 'fine', 'alright', 'all', 'right'
]);

const GREETING_PATTERN = /^(?:hi|hello|hey|aoa|salam|assalam(?:[\s-]?o[\s-]?alaikum|[\s-]?alaikum)?)[!.,\s]*$/i;

// A request for another appointment has to be explicit. A greeting or a question
// about the existing booking must never restart the booking flow.
const NEW_BOOKING_PATTERN = new RegExp(
  '^(?:appointment|booking|book|book\\s+appointment|new\\s+appointment|nayi\\s+appointment|naya\\s+appointment)[!.,\\s]*$'
  + '|\\b(?:book|booking)\\s+(?:a\\s+)?(?:new\\s+)?(?:appointment|slot)\\b'
  + '|\\bnew\\s+(?:appointment|booking)\\b'
  + '|\\b(?:nayi|naya|dobara|another)\\s+(?:appointment|booking)\\b'
  + '|\\bappointment\\s+(?:book|chahiye|kar(?:na|ni|wa))\\b'
  + '|\\bappointment\\s+(?:lena|leni)\\s+(?:hai|chahta|chahti)\\b'
  + '|\\b(?:book|booking)\\s+kar(?:na|ni|wa)\\s+(?:hai|chahta|chahti)\\b',
  'i'
);

function normalizeMessage(message) {
  return String(message || '').trim();
}

function isConfirmationQuery(message) {
  return CONFIRMATION_PATTERN.test(normalizeMessage(message));
}

function isGratitudeMessage(message) {
  return GRATITUDE_PATTERN.test(normalizeMessage(message));
}

function isClosingMessage(message) {
  const text = normalizeMessage(message);
  if (!text) return false;
  if (FAREWELL_PATTERN.test(text)) return true;

  const words = text.replace(/[^a-z\s]/gi, ' ').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 5 && words.every((word) => CLOSING_WORDS.has(word));
}

function isPostBookingGreeting(message) {
  return GREETING_PATTERN.test(normalizeMessage(message));
}

function isNewBookingRequest(message) {
  return NEW_BOOKING_PATTERN.test(normalizeMessage(message));
}

// Returns the strongest meaning of the message in the post-booking context, or
// null when it is not one of the follow-ups this layer owns, so the caller can
// answer it another way instead of restarting the welcome flow.
function detectPostBookingIntent(message) {
  if (isConfirmationQuery(message)) return 'confirmation';
  if (isClosingMessage(message)) return 'closing';
  if (isGratitudeMessage(message)) return 'gratitude';
  if (isPostBookingGreeting(message)) return 'greeting';
  if (isNewBookingRequest(message)) return 'newBooking';
  return null;
}

function getPatientName(appointment) {
  const name = appointment?.details?.name;
  return typeof name === 'string' ? name.trim() : '';
}

function formatAppointmentWhen(appointment, timeZone) {
  const start = new Date(appointment?.slotStart);
  if (Number.isNaN(start.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'Asia/Karachi',
    dateStyle: 'full',
    timeStyle: 'short'
  }).format(start);
}

function formatVenue(doctorProfile) {
  return [doctorProfile?.doctorName, doctorProfile?.clinicName]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .join(', ');
}

function formatNotConfirmedReply() {
  return 'Aap ki is waqt koi confirmed appointment nahi mili. '
    + 'Agar aap ne abhi booking ki thi to baraye meherbani thori dair baad dobara check karein. '
    + 'Nayi appointment book karne ke liye "appointment" likh kar bhejein.';
}

function formatConfirmationReply(appointment, doctorProfile = {}, timeZone = 'Asia/Karachi') {
  if (!appointment) return formatNotConfirmedReply();

  const name = getPatientName(appointment);
  const when = formatAppointmentWhen(appointment, timeZone);
  const venue = formatVenue(doctorProfile);
  return `Ji haan${name ? `, ${name}` : ''}! Aap ki appointment${when ? ` ${when}` : ''}`
    + `${venue ? ` (${venue})` : ''} par confirm hai. `
    + 'Agar koi tabdeeli chahiye to "reschedule" likh kar bhejein.';
}

function formatGratitudeReply(appointment) {
  const name = getPatientName(appointment);
  return `Aap ka bohat shukriya${name ? `, ${name}` : ''}! Hum aap ki khidmat ke liye hazir hain.`;
}

function formatClosingReply(appointment) {
  const name = getPatientName(appointment);
  return `Aap ka bohat shukriya${name ? `, ${name}` : ''}! Hum aap ke tashreef laane ke muntazir hain. Allah Hafiz.`;
}

function formatGreetingReply(appointment, doctorProfile = {}, timeZone = 'Asia/Karachi', message = '') {
  const name = getPatientName(appointment);
  const when = formatAppointmentWhen(appointment, timeZone);
  const isSalam = /salam|aoa/i.test(normalizeMessage(message));
  const salutation = isSalam ? 'Walaikum Assalam' : 'Hello';
  return `${salutation}${name ? `, ${name}` : ''}! Aap ki appointment${when ? ` ${when}` : ''} par confirm hai. `
    + 'Kya main kisi aur cheez mein madad kar sakta hoon?';
}

// Used for anything else the patient sends after booking: stay in context and
// offer the useful next steps rather than showing the welcome menu again.
function formatPostBookingFallbackReply(appointment, doctorProfile = {}, timeZone = 'Asia/Karachi') {
  const when = formatAppointmentWhen(appointment, timeZone);
  return `Aap ki appointment${when ? ` ${when}` : ''} par confirm hai. `
    + 'Appointment change karne ke liye "reschedule", nayi appointment ke liye "appointment" likhein, '
    + 'ya clinic ki tafseelat poochein.';
}

module.exports = {
  detectPostBookingIntent,
  formatClosingReply,
  formatConfirmationReply,
  formatGratitudeReply,
  formatGreetingReply,
  formatNotConfirmedReply,
  formatPostBookingFallbackReply,
  isClosingMessage,
  isConfirmationQuery,
  isGratitudeMessage,
  isNewBookingRequest,
  isPostBookingGreeting
};
