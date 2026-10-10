// End to end check for the daily email report path.
//
// The system panel reported "Not configured" or "Configured" but never proved that
// the host could actually reach the SMTP server and accept the credentials, and a
// clinic had no way to test delivery without waiting for its scheduled report.
// This runs the same transporter the scheduler uses, so a failure names the exact
// stage instead of surfacing as a missing report the next morning.
//
// Credentials are read from the environment and never returned or logged.
const nodemailer = require('nodemailer');

const REQUIRED_SETTINGS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'];
const DEFAULT_TIMEOUT_MS = 20_000;

// Reports which settings are missing without revealing any value.
function describeEmailConfiguration(environment = process.env) {
  const missing = REQUIRED_SETTINGS.filter((name) => !String(environment[name] ?? '').trim());
  const port = Number(environment.SMTP_PORT || '587');
  const portValid = Number.isInteger(port) && port >= 1 && port <= 65535;
  const problems = [...missing];
  if (!portValid) problems.push('SMTP_PORT');
  return {
    ready: problems.length === 0,
    missing: problems,
    host: environment.SMTP_HOST ? String(environment.SMTP_HOST) : null,
    port: portValid ? port : null,
    secure: environment.SMTP_SECURE === 'true' || port === 465,
    requiresTls: environment.SMTP_REQUIRE_TLS !== 'false' && port !== 465,
    from: environment.EMAIL_FROM ? String(environment.EMAIL_FROM) : null
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Translates the common SMTP failures into something an operator can act on,
// because "Invalid credentials" and "connection timeout" need different fixes.
function explainSmtpFailure(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || error || '');
  if (/EAUTH|Invalid credentials|535|Authentication/i.test(`${code} ${message}`)) {
    return 'SMTP rejected the username or password. For Gmail use an App Password, not the account password, '
      + 'and confirm SMTP_USER matches the account the app password was generated for.';
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(`${code} ${message}`)) {
    return `Could not reach ${error?.host || 'the SMTP host'}. Check SMTP_HOST and that the host allows outbound port ${error?.port || 587}.`;
  }
  if (/ETIMEDOUT|ESOCKET|Connection timeout/i.test(`${code} ${message}`)) {
    return 'The SMTP host accepted the address but did not answer. This is usually a firewall or blocked outbound port.';
  }
  if (/ETIMEDOUT|handshake|self.signed|SSL|TLS|certificate/i.test(`${code} ${message}`)) {
    return 'TLS negotiation failed. Try SMTP_SECURE=true with port 465, or set SMTP_REQUIRE_TLS=false for a host that does not support STARTTLS.';
  }
  if (error?.code === 'EAUTH') return 'SMTP authentication failed.';
  return message || 'The SMTP server returned an unknown error.';
}

async function diagnoseEmailPipeline(options = {}) {
  const environment = options.environment || process.env;
  const stages = [];
  const record = (stage, ok, detail) => { stages.push({ stage, ok, detail }); return ok; };

  const configuration = describeEmailConfiguration(environment);
  if (!record('configuration', configuration.ready, configuration.ready
    ? `Using ${configuration.host}:${configuration.port}${configuration.secure ? ' (TLS)' : ' (STARTTLS)'}`
    : `missing or invalid: ${configuration.missing.join(', ')}`)) {
    return { ready: false, stages, configuration };
  }

  let transport;
  try {
    transport = nodemailer.createTransport({
      host: configuration.host,
      port: configuration.port,
      secure: configuration.secure,
      requireTLS: configuration.requiresTls,
      auth: { user: environment.SMTP_USER, pass: environment.SMTP_PASS }
    });
  } catch (error) {
    record('transporter', false, 'The SMTP transporter could not be created from these settings.');
    return { ready: false, stages, configuration };
  }

  try {
    await withTimeout(transport.verify(), options.timeoutMs || DEFAULT_TIMEOUT_MS, 'SMTP verification');
    if (!record('smtp-connection', true, 'The server accepted the host, TLS and credentials.')) {
      return { ready: false, stages, configuration };
    }
  } catch (error) {
    record('smtp-connection', false, explainSmtpFailure(error));
    return { ready: false, stages, configuration };
  }

  const recipient = String(options.sendTo || environment.EMAIL_FROM || '').trim();
  if (!options.send) {
    record('delivery', true, 'Not sending a test message. Use the test button to send one.');
    return { ready: true, stages, configuration };
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    record('delivery', false, 'No valid recipient address to send the test message to.');
    return { ready: false, stages, configuration };
  }

  try {
    const result = await withTimeout(transport.sendMail({
      from: configuration.from,
      to: recipient,
      subject: 'DoctorBot email test',
      text: `This is a test message confirming that ${configuration.host} can deliver email for the daily clinic reports.`
    }), options.timeoutMs || DEFAULT_TIMEOUT_MS, 'Test message');
    record('delivery', true, `Test message accepted by the server${result?.messageId ? ` (id ${result.messageId})` : ''}.`);
    return { ready: true, stages, configuration, recipient };
  } catch (error) {
    record('delivery', false, explainSmtpFailure(error));
    return { ready: false, stages, configuration };
  }
}

module.exports = { REQUIRED_SETTINGS, describeEmailConfiguration, diagnoseEmailPipeline, explainSmtpFailure };