const { formatFacilityRate, formatRupees } = require('./facilityPricing');

function getWelcomeMessage(message, doctorProfile) {
  const normalizedMessage = String(message || '').trim();
  let greeting = 'Ji farmaiye';

  if (/^hi[!.\s]*$/i.test(normalizedMessage)) {
    greeting = 'Hello';
  } else if (/^(?:salam|assalam(?:-?o-?alaikum| alaikum))[!.\s]*$/i.test(normalizedMessage)) {
    greeting = 'Walaikum Assalam';
  }

  const welcomeMessage = doctorProfile.welcomeMessage?.trim();
  const facilities = doctorProfile.facilitiesList || [];
  const services = doctorProfile.servicesList || [];
  const consultationDetails = doctorProfile.consultationDetails?.trim();
  const basicCheckupFee = formatRupees(doctorProfile.basicCheckupFee);
  return `${greeting}! ${doctorProfile.doctorName} ke ${doctorProfile.clinicName} mein khush aamdeed!\n` +
    (welcomeMessage ? `${welcomeMessage}\n` : '') +
    `Basic checkup fee: ${basicCheckupFee || 'price ke liye rabta karein'}\n\n` +
    `Hamari sahuliyaat aur rates:\n${facilities.map((facility, index) => `${index + 1}. ${formatFacilityRate(doctorProfile, facility)}`).join('\n')}\n\n` +
    (services.length ? `Hamari services aur treatments:\n${services.map((service, index) => `${index + 1}. ${service}`).join('\n')}\n\n` : '') +
    (services.length ? `Services ke rates:\n${services.map((service, index) => `${index + 1}. ${formatFacilityRate(doctorProfile, service)}`).join('\n')}\n\n` : '') +
    (consultationDetails ? `${consultationDetails}\n\n` : '') +
    'Meherbani karke apna naam batayein.';
}

module.exports = { getWelcomeMessage };