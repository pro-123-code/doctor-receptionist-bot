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
  const facilityLines = facilities.map((facility, index) =>
    `${index + 1}. ${formatFacilityRate(doctorProfile, facility)}`);
  const serviceLines = services.map((service, index) =>
    `${index + 1}. ${formatFacilityRate(doctorProfile, service)}`);
  return `${greeting}! ${doctorProfile.doctorName} ke ${doctorProfile.clinicName} mein khush aamdeed!\n` +
    (welcomeMessage ? `${welcomeMessage}\n` : '') +
    `Basic checkup fee: ${basicCheckupFee || 'price ke liye rabta karein'}\n\n` +
    (facilityLines.length ? `Hamari sahuliyaat aur rates:\n${facilityLines.join('\n')}\n\n` : '') +
    (serviceLines.length ? `Hamari services/treatments aur rates:\n${serviceLines.join('\n')}\n\n` : '') +
    (consultationDetails ? `${consultationDetails}\n\n` : '') +
    'Meherbani karke apna naam batayein.';
}

module.exports = { getWelcomeMessage };
