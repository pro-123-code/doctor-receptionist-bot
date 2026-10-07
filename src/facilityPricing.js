const maximumPrice = 10_000_000;
const maximumRows = 40;
const maximumNameLength = 100;

function isValidRupeeAmount(amount) {
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 && amount <= maximumPrice &&
    Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-8;
}

// Every rejection used to collapse into one "add at least one facility" message,
// so a blank price or a duplicated name was reported as though the clinic had
// nothing saved at all. Each failure now names what actually needs fixing.
function normalizeFacilityPricing(value) {
  if (!Array.isArray(value)) return { rows: null, error: 'The clinic list could not be read. Reload the page and try again.' };
  if (value.length < 1) {
    return {
      rows: null,
      error: 'Add at least one facility or treatment, using the "Add facility or treatment" button.'
    };
  }
  if (value.length > maximumRows) {
    return { rows: null, error: `A clinic can list at most ${maximumRows} facilities or treatments.` };
  }

  const rows = [];
  const names = new Set();
  for (const item of value) {
    const label = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!label) {
      return { rows: null, error: 'Every facility or treatment needs a name. Fill in or remove the empty row.' };
    }
    if (label.length > maximumNameLength) {
      return { rows: null, error: `"${label.slice(0, 40)}…" is too long. Names must be ${maximumNameLength} characters or fewer.` };
    }
    const category = item.category || 'facility';
    if (!['facility', 'service'].includes(category)) {
      return { rows: null, error: `"${label}" must be marked as either a Facility or a Treatment or service.` };
    }
    if (names.has(label.toLocaleLowerCase('en'))) {
      return { rows: null, error: `"${label}" is listed more than once. Rename or remove the duplicate.` };
    }
    const rawPrice = typeof item.price === 'number' ? item.price : String(item.price ?? '').trim();
    if (rawPrice === '') {
      return { rows: null, error: `Enter a price in rupees for "${label}", or type 0 if it is free.` };
    }
    const price = typeof rawPrice === 'number' ? rawPrice : Number(rawPrice);
    if (!isValidRupeeAmount(price)) {
      return { rows: null, error: `"${price}" is not a valid price for "${label}". Use a number of rupees between 0 and ${maximumPrice.toLocaleString('en')}.` };
    }
    names.add(label.toLocaleLowerCase('en'));
    rows.push({ category, name: label, price });
  }
  return { rows, error: null };
}

function formatRupees(amount) {
  if (amount === null || amount === undefined || amount === '') return null;
  const price = Number(amount);
  if (!Number.isFinite(price) || price < 0) return null;
  return `Rs. ${new Intl.NumberFormat('en-PK', { maximumFractionDigits: 2 }).format(price)}`;
}

function getFacilityPrice(doctorProfile, itemName) {
  const normalizedName = String(itemName || '').trim().toLocaleLowerCase('en');
  const item = doctorProfile.facilityPricing?.find(({ name }) =>
    String(name).trim().toLocaleLowerCase('en') === normalizedName
  );
  return item ? formatRupees(item.price) : null;
}

function formatFacilityRate(doctorProfile, itemName) {
  const price = getFacilityPrice(doctorProfile, itemName);
  return `${itemName}: ${price || 'price ke liye rabta karein'}`;
}

module.exports = {
  formatFacilityRate,
  formatRupees,
  getFacilityPrice,
  isValidRupeeAmount,
  maximumNameLength,
  maximumPrice,
  maximumRows,
  normalizeFacilityPricing
};