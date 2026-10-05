const maximumPrice = 10_000_000;

function isValidRupeeAmount(amount) {
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 && amount <= maximumPrice &&
    Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-8;
}

function normalizeFacilityPricing(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 40) return null;
  const normalized = [];
  const names = new Set();
  for (const item of value) {
    if (typeof item?.name !== 'string' || !item.name.trim() || item.name.trim().length > 100) return null;
    const name = item.name.trim();
    const normalizedName = name.toLocaleLowerCase('en');
    if ((typeof item.price !== 'number' && typeof item.price !== 'string') ||
      (typeof item.price === 'string' && !item.price.trim())) return null;
    const price = typeof item.price === 'number' ? item.price : Number(item.price);
    if (names.has(normalizedName) || !isValidRupeeAmount(price)) return null;
    names.add(normalizedName);
    normalized.push({ name, price });
  }
  return normalized;
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

module.exports = { formatFacilityRate, formatRupees, getFacilityPrice, isValidRupeeAmount, normalizeFacilityPricing };