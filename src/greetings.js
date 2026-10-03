function getWelcomeMessage(message, doctorProfile) {
  const normalizedMessage = String(message || '').trim();
  let greeting = 'Ji farmaiye';

  if (/^hi[!.\s]*$/i.test(normalizedMessage)) {
    greeting = 'Hello';
  } else if (/^(?:salam|assalam(?:-?o-?alaikum| alaikum))[!.\s]*$/i.test(normalizedMessage)) {
    greeting = 'Walaikum Assalam';
  }

  const welcomeMessage = doctorProfile.welcomeMessage?.trim() ||
    `${doctorProfile.doctorName} ke ${doctorProfile.clinicName} mein khush aamdeed!`;
  const facilities = doctorProfile.facilitiesList || [];
  return `${greeting}! ${welcomeMessage}\n` +
    `Hamari sahuliyaat:\n${facilities.map((facility, index) => `${index + 1}. ${facility}`).join('\n')}\n\n` +
    'Meherbani karke apna naam batayein.';
}

module.exports = { getWelcomeMessage };