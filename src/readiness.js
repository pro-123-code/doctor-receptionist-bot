// Central readiness reporting for optional integrations.
//
// Every disabled feature in the system status panel was disabled by missing
// configuration, not by broken code. The panel only said "Disabled", which gave
// an operator no way to tell what to set, so each feature now reports the exact
// environment variable names it needs and the remedy.
//
// Only variable NAMES are ever reported. Values are never read back out, so this
// is safe to render in a browser or log.

const FEATURE_LABELS = {
  voiceTranscription: 'Voice transcription',
  geminiExtraction: 'Gemini extraction',
  emailReports: 'Daily email reports',
  whatsappSessions: 'WhatsApp session persistence',
  googleCalendar: 'Google Calendar',
  trustProxy: 'Trusted proxy'
};

function present(environment, name) {
  return Boolean(String(environment[name] ?? '').trim());
}

function requireVariables(environment, names) {
  return names.filter((name) => !present(environment, name));
}

function hasConsent(environment, name) {
  return String(environment[name] ?? '').trim().toLowerCase() === 'true';
}

// A mounted persistent disk is what actually makes sessions survive a deploy, so
// readiness reports ready when one is present even without the variable set.
const DISK_ROOTS = ['/data', '/var/data', '/mnt/data'];

function existsSyncSafe(target) {
  try {
    // Deliberately avoids pulling in fs at module scope so this stays pure enough
    // to test with an injected existence check.
    return require('node:fs').existsSync(target);
  } catch {
    return false;
  }
}

// Evaluates every optional integration against an environment object. Pure, so it
// can be unit tested and reused by the startup log and the admin system panel.
function evaluateReadiness(environment = process.env, options = {}) {
  const features = {};
  const diskRoots = options.diskRoots || DISK_ROOTS;

  const voiceMissing = requireVariables(environment, ['OPENAI_API_KEY']);
  const voiceConsent = hasConsent(environment, 'OPENAI_ALLOW_PHI_PROCESSING');
  const voiceMissingAll = [
    ...voiceMissing,
    ...(voiceConsent ? [] : ['OPENAI_ALLOW_PHI_PROCESSING'])
  ];
  features.voiceTranscription = {
    ready: voiceMissingAll.length === 0,
    missing: voiceMissingAll,
    remedy: 'Add an OpenAI API key and set OPENAI_ALLOW_PHI_PROCESSING=true in the Render environment variables, then redeploy. '
      + 'This flag confirms you approve sending patient voice data to the transcription provider.'
  };

  const geminiMissing = requireVariables(environment, ['GEMINI_API_KEY']);
  const geminiConsent = hasConsent(environment, 'GEMINI_ALLOW_PHI_PROCESSING');
  const geminiMissingAll = [
    ...geminiMissing,
    ...(geminiConsent ? [] : ['GEMINI_ALLOW_PHI_PROCESSING'])
  ];
  features.geminiExtraction = {
    ready: geminiMissingAll.length === 0,
    missing: geminiMissingAll,
    remedy: 'Set GEMINI_ALLOW_PHI_PROCESSING=true in the Render environment variables, then redeploy. '
      + 'This flag confirms you approve sending patient appointment text to Google for extraction.'
  };

  const emailRequired = requireVariables(environment, ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM']);
  const emailMissing = emailRequired.length ? emailRequired : requireVariables(environment, ['SMTP_HOST']);
  features.emailReports = {
    ready: emailRequired.length === 0,
    missing: emailMissing,
    remedy: 'Create an SMTP sender (a Gmail app password works), then set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS '
      + 'and EMAIL_FROM in the Render environment variables and redeploy. Each clinic also needs an email address '
      + 'on its profile to receive its report.'
  };

  const sessionsMissing = requireVariables(environment, ['BAILEYS_AUTH_DIR']);
  const diskMounted = diskRoots.some((candidate) => existsSyncSafe(candidate));
  features.whatsappSessions = {
    ready: (sessionsMissing.length === 0 || diskMounted) && (options.sessionWritable !== false),
    missing: sessionsMissing,
    remedy: diskMounted
      ? 'A persistent disk is mounted, so WhatsApp sessions already survive deploys. Set BAILEYS_AUTH_DIR to that '
        + 'mount path anyway so the location is explicit and survives a disk remount.'
      : 'Attach a persistent disk in Render (Settings > Disks, mount path /data) and set BAILEYS_AUTH_DIR=/data/sessions, '
        + 'then redeploy. Without this, every clinic must re-scan its WhatsApp QR code after each deploy. '
        + 'Persistent disks require a paid Render plan.'
  };

  const googleMissing = requireVariables(environment, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  const redirectValid = options.googleRedirectUriValid === true;
  features.googleCalendar = {
    ready: googleMissing.length === 0 && redirectValid,
    missing: googleMissing,
    remedy: googleMissing.length
      ? 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from the Google Cloud project, then redeploy.'
      : 'Set GOOGLE_REDIRECT_URI to this deployment\'s /api/auth/google/callback URL and add the same URL to the '
        + 'Google Cloud OAuth client, then redeploy.'
  };

  const proxyMissing = requireVariables(environment, ['TRUST_PROXY']);
  features.trustProxy = {
    ready: proxyMissing.length === 0,
    missing: proxyMissing,
    remedy: 'Set TRUST_PROXY=true in the Render environment variables, then redeploy. Render terminates TLS, '
      + 'so without this the dashboard login cookie is not marked secure and the Google redirect URL is derived as http.'
  };

  const blocked = Object.entries(features)
    .filter(([, feature]) => !feature.ready)
    .map(([key, feature]) => ({
      key,
      label: FEATURE_LABELS[key] || key,
      missing: feature.missing,
      remedy: feature.remedy
    }));

  return { features, blocked, ready: blocked.length === 0 };
}

module.exports = { DISK_ROOTS, FEATURE_LABELS, evaluateReadiness, requireVariables };