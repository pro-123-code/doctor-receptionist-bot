// Public legal pages required by the Google OAuth consent screen.
// The clinic operator should replace the placeholder identity block below with
// their real clinic name, address and contact details before going live.
const clinicName = process.env.LEGAL_CLINIC_NAME || 'the clinic operating this service';
const contactEmail = process.env.LEGAL_CONTACT_EMAIL || process.env.DASHBOARD_EMAIL || process.env.SUPERADMIN_EMAIL || 'clinic@example.com';
const lastUpdated = process.env.LEGAL_LAST_UPDATED || new Date().toISOString().slice(0, 10);

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${title}</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; background: #f3f7f5; color: #1f2933;
           font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    main { max-width: 760px; margin: 0 auto; padding: 40px 20px 80px; background: #fff;
           min-height: 100vh; box-shadow: 0 0 24px rgba(0,0,0,.05); }
    h1 { color: #176b5b; font-size: 1.9rem; margin: 0 0 4px; }
    h2 { color: #176b5b; font-size: 1.15rem; margin: 32px 0 8px; }
    .updated { color: #52606d; font-size: .85rem; margin: 0 0 8px; }
    ul { padding-left: 20px; }
    li { margin: 6px 0; }
    .note { background: #f0f7f5; border-left: 4px solid #176b5b; padding: 12px 14px; margin: 20px 0; border-radius: 4px; }
    footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e4e7eb; color: #52606d; font-size: .85rem; }
    a { color: #176b5b; }
  </style>
</head>
<body>
<main>
${body}
<footer>
  <p>Questions about this policy? Contact us at <a href="mailto:${contactEmail}">${contactEmail}</a>.</p>
  <p>Last updated: ${lastUpdated}</p>
</footer>
</main>
</body>
</html>`;
}

function privacyPolicy() {
  return page('Privacy Policy', `
<h1>Privacy Policy</h1>
<p class="updated">Applies to the WhatsApp appointment service operated by ${clinicName}.</p>

<div class="note">
  <strong>This service is not for emergencies.</strong> If you have a medical emergency,
  contact your local emergency number immediately. Do not use WhatsApp for urgent care.
</div>

<h2>What we collect</h2>
<p>When you message this service we collect the information you choose to provide, which may include:</p>
<ul>
  <li>Your name</li>
  <li>Your WhatsApp phone number</li>
  <li>The symptoms or reason for your visit, as you describe it</li>
  <li>Your requested and booked appointment date and time</li>
  <li>Voice notes you send, and the text transcribed from them</li>
</ul>

<h2>Why we collect it</h2>
<p>Only to schedule and manage your appointment, to prepare for your visit, and to send you
appointment reminders. We do not use your information for advertising, and we do not sell or
share it with third parties for their own purposes.</p>

<h2>Automated assistance</h2>
<p>Replies are assisted by automated software that extracts the appointment details you provide.
This software does not diagnose, does not give medical advice, and does not replace a
consultation with a clinician. All clinical decisions are made by the clinic's clinician.</p>

<h2>Voice notes</h2>
<p>If you send a voice note, it is converted to text so the booking flow can continue. Voice audio
is deleted automatically within 24 hours of receipt and is not retained. Speech-to-text processing
is performed by a third-party provider and is only enabled where the clinic has obtained the
necessary permissions for processing patient data.</p>

<h2>Where your data is stored</h2>
<p>Appointment records and conversation history are stored in an encrypted database operated on
behalf of the clinic. Booked appointment records are retained so the clinic can deliver care and
meeting its record-keeping obligations; transient message content expires automatically within
24 hours.</p>

<h2>Service providers</h2>
<p>We use a small number of processors to operate this service, each bound to use your data only
for that purpose:</p>
<ul>
  <li><strong>Meta / WhatsApp</strong> &mdash; to deliver your messages.</li>
  <li><strong>Google</strong> &mdash; to store appointment bookings on the clinic's calendar.</li>
  <li><strong>Database hosting</strong> &mdash; to store appointment records.</li>
  <li><strong>Email delivery</strong> &mdash; to send the clinic its daily appointment list.</li>
  <li><strong>Speech-to-text</strong> &mdash; to transcribe voice notes, where enabled.</li>
</ul>

<h2>Your choices and rights</h2>
<p>You may ask us to correct or delete the personal information we hold about you, or to stop
contacting you through this service. Because appointment records support your direct care and the
clinic's legal obligations, some records must be retained even if you request deletion. To make a
request, contact the clinic using the details below.</p>

<h2>Security</h2>
<p>Access to appointment data is restricted to the clinic's authorised staff and administrators.
Connection credentials are encrypted in storage and passwords are stored only as salted hashes.</p>

<h2>Changes to this policy</h2>
<p>We may update this policy as the service changes. The date below shows when it was last revised.</p>
`);
}

function termsOfService() {
  return page('Terms of Service', `
<h1>Terms of Service</h1>
<p class="updated">Applies to the WhatsApp appointment service operated by ${clinicName}.</p>

<h2>What this service is</h2>
<p>This service is an automated assistant that helps schedule appointments and share basic clinic
information such as fees and opening hours. It is a convenience tool operated by the clinic.</p>

<h2>Not medical advice</h2>
<p>Nothing you receive here is a diagnosis, treatment plan or medical advice. The assistant does not
examine you, cannot assess your condition, and may mis-transcribe or mis-understand what you send.
Always discuss your symptoms with the clinic's clinician during your appointment.</p>

<div class="note">
  <strong>Not for emergencies.</strong> If you have a medical emergency, contact your local
  emergency number immediately rather than messaging this service.
</div>

<h2>Appointments</h2>
<p>An appointment is only confirmed once the clinic's calendar shows the booking. Times offered by
the assistant reflect the clinician's availability at the moment they are shown and may change;
the clinic's calendar is authoritative. Please do not travel based on a message alone &mdash;
contact the clinic if you need to confirm.</p>

<h2>Accuracy of information</h2>
<p>Fees, services and opening hours are supplied by the clinic and may change without notice. If
information appears incorrect, please contact the clinic directly.</p>

<h2>Acceptable use</h2>
<p>Please do not use this service to send abusive, threatening or unlawful content, to harass clinic
staff, or to attempt to disrupt the service. We may block access where these terms are not followed.</p>

<h2>Limitation of liability</h2>
<p>To the extent permitted by law, the clinic is not liable for losses arising from reliance on
automated messages, including transcription errors, delayed replies, or changes to availability.
Nothing in these terms limits your statutory rights as a patient or consumer.</p>

<h2>Governing terms</h2>
<p>These terms apply to your use of this appointment service. Your use of the service indicates
acceptance of these terms.</p>
`);
}

module.exports = { privacyPolicy, termsOfService };