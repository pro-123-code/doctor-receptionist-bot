const secretEnvironmentKeys = [
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'GEMINI_API_KEY',
  'MONGODB_URI',
  'SMTP_PASS',
  'DASHBOARD_PASSWORD',
  'DASHBOARD_COOKIE_SECRET',
  'DASHBOARD_SESSION_SECRET',
  'DOCTOR_CONFIG_ENCRYPTION_KEY'
];

function getErrorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = current.cause;
  }
  return chain;
}

function redactSensitiveText(message, environment = process.env) {
  let sanitized = String(message || 'No error message provided');
  for (const key of secretEnvironmentKeys) {
    const secret = environment[key];
    if (typeof secret === 'string' && secret.length >= 4) {
      sanitized = sanitized.split(secret).join('[REDACTED]');
    }
  }

  return sanitized
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(access_token|refresh_token|client_secret|password|api_key|key)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"']+/gi, '[REDACTED_MONGODB_URI]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 1000);
}

function getCalendarErrorDetails(error, environment = process.env) {
  const chain = getErrorChain(error);
  const responseError = chain.find((item) => item.response?.data?.error?.message);
  const responseMessage = responseError?.response?.data?.error?.message ||
    chain.find((item) => item.response?.data?.message)?.response?.data?.message;
  const message = responseMessage || chain.find((item) => item.message)?.message;
  const status = chain.find((item) => item.response?.status)?.response?.status;
  const providerReason = responseError?.response?.data?.error?.errors?.[0]?.reason;
  const providerCode = responseError?.response?.data?.error?.code;
  const rawCode = providerReason || providerCode || chain.find((item) => item.code)?.code || status;
  const code = /^[A-Za-z0-9_-]{1,64}$/.test(String(rawCode || '')) ? String(rawCode) : undefined;

  return {
    message: redactSensitiveText(message, environment),
    status: Number.isInteger(status) ? status : undefined,
    code
  };
}

module.exports = { getCalendarErrorDetails, redactSensitiveText };