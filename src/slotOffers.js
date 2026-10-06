// Slot offering is separated from the server bootstrap so it can be unit tested:
// src/server.js runs the HTTP listener on import and cannot be required in tests.

function getZonedDateParts(date, timeZone) {
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

function getSlotLocalDateKey(date, timeZone) {
  const parts = getZonedDateParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

// Interleave times across every open day so a patient always sees later slots
// (for example afternoon appointments) instead of only the first morning ones.
function buildOfferOrder(slots, timeZone) {
  const slotsByDate = new Map();
  for (const slot of slots) {
    const key = getSlotLocalDateKey(slot.start, timeZone);
    if (!slotsByDate.has(key)) slotsByDate.set(key, []);
    slotsByDate.get(key).push(slot);
  }

  const queues = [...slotsByDate.values()];
  const ordered = [];
  for (let round = 0; ; round += 1) {
    let addedInRound = 0;
    for (const queue of queues) {
      if (queue[round]) {
        ordered.push(queue[round]);
        addedInRound += 1;
      }
    }
    if (!addedInRound) break;
  }
  return ordered;
}

function paginateSlots(availableSlots, offset, options = {}) {
  const timeZone = options.timeZone || 'Asia/Karachi';
  const limit = Number.isInteger(options.limit) && options.limit >= 4 && options.limit <= 24
    ? options.limit
    : 12;
  const ordered = buildOfferOrder(availableSlots, timeZone);
  const start = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const slots = ordered.slice(start, start + limit);
  const nextOffset = start + slots.length;
  return { slots, moreAvailable: nextOffset < ordered.length, nextOffset, totalAvailable: ordered.length };
}

function formatSlotOffer(slots, formatSlot, moreAvailable, intro = 'Meherbani karke neeche diye gaye auqaat mein se ek muntakhib karein:') {
  const lines = slots.map((slot, index) => formatSlot(slot, index)).join('\n');
  return `${intro}\n${lines}\n\nSirf slot ka number reply karein.` +
    (moreAvailable ? '\nAur waqt dekhne ke liye "more" likhein.' : '');
}

const moreSlotRequestPattern = /^(more|mor|aur|aur waqt|agla|agle|next|baqi|baaki|andhera)\b/i;

function isMoreSlotRequest(message) {
  return moreSlotRequestPattern.test(String(message || '').trim());
}

module.exports = {
  buildOfferOrder,
  formatSlotOffer,
  getSlotLocalDateKey,
  getZonedDateParts,
  isMoreSlotRequest,
  paginateSlots
};