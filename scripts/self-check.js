// Watches the running service instead of trusting that it is running.
//
// This exists because two faults shipped while every test passed. The appointments
// table had never rendered a row and the database session store had never run, and
// nothing noticed either, because the only thing watching the service was a person
// opening the dashboard. Two faults is not a pattern that survives on vigilance.
//
// It checks two things. The service answers and reports a healthy database, and the
// service reports the commit it was built from. The second check is the important one:
// a deploy can succeed and leave an older bundle running, which looks identical to a
// healthy service unless the commit is compared.
//
// It runs on a schedule with no external dependency and no paid plan. A free external
// monitor such as UptimeRobot or Better Stack pointed at /health is still worth having,
// because this runs inside the service and cannot report that the service itself is
// gone. The two are complementary, not alternatives.
const https = require('node:https');

const BASE_URL = (process.env.SELF_CHECK_BASE_URL || 'https://doctor-receptionist-bot.onrender.com')
  .replace(/\/+$/, '');
const EXPECTED_COMMIT = process.env.EXPECTED_COMMIT || '';
const TIMEOUT_MS = 20000;
const RETRIES = 3;
const RETRY_DELAY_MS = 5000;

// Only failures are sent. A healthy service has nothing useful to say, and an alert
// that arrives when nothing is wrong is an alert that gets ignored.
async function notifyFailure(message) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) {
    console.error(`SELF-CHECK FAILED: ${message}`);
    console.error('No ALERT_WEBHOOK_URL set, so this is only in the service log. '
      + 'Point a free monitor at /health or set ALERT_WEBHOOK_URL to be told directly.');
    return { sent: false, reason: 'ALERT_WEBHOOK_URL is not set' };
  }
  try {
    const response = await post(url, { text: `DoctorBot self check failed: ${message}` });
    if (response.statusCode >= 200 && response.statusCode < 300) {
      console.error(`SELF-CHECK FAILED: ${message} (alert delivered)`);
      return { sent: true };
    }
    console.error(`SELF-CHECK FAILED: ${message} (alert rejected with ${response.statusCode})`);
    return { sent: false, reason: `webhook returned ${response.statusCode}` };
  } catch (error) {
    console.error(`SELF-CHECK FAILED: ${message} (alert could not be sent: ${error.message})`);
    return { sent: false, reason: error.message };
  }
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const request = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (response) => {
      response.resume();
      resolve({ statusCode: response.statusCode });
    });
    request.on('error', reject);
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error('alert request timed out')));
    request.write(payload);
    request.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    const request = https.get(`${BASE_URL}${path}`, { timeout: TIMEOUT_MS }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 200000) request.destroy();
      });
      response.on('end', () => resolve({ statusCode: response.statusCode, body }));
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error(`${path} timed out after ${TIMEOUT_MS}ms`)));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkOnce() {
  // Health first. A 503 means the process is up but the database is not, which is a
  // different fault from being down and needs a different response.
  const health = await get('/health');
  if (health.statusCode !== 200) {
    let detail = '';
    try { detail = JSON.parse(health.body).status || health.body.slice(0, 120); } catch { detail = health.body.slice(0, 120); }
    return { ok: false, problem: `/health returned ${health.statusCode} (${detail})` };
  }
  let status;
  try {
    status = JSON.parse(health.body);
  } catch {
    return { ok: false, problem: '/health did not return JSON, so the answer cannot be trusted' };
  }
  if (status.status !== 'ok') {
    return { ok: false, problem: `/health reports "${status.status}", so the database is not connected` };
  }

  // The commit check. A service can be perfectly healthy while running an older build,
  // which is how a deploy appears to succeed while a fix is not actually live.
  if (EXPECTED_COMMIT) {
    const version = await get('/version');
    let commit = null;
    try { commit = JSON.parse(version.body).commit; } catch { /* reported below */ }
    if (!commit) {
      return { ok: false, problem: '/version did not report a commit, so a deploy cannot be confirmed' };
    }
    if (!String(commit).startsWith(EXPECTED_COMMIT.slice(0, 7)) && commit !== EXPECTED_COMMIT) {
      return {
        ok: false,
        problem: `the service is healthy but serving commit ${commit}, not the expected ${EXPECTED_COMMIT}`
      };
    }
  }

  return { ok: true, commit: EXPECTED_COMMIT || 'not checked' };
}

async function main() {
  let last = null;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      last = await checkOnce();
    } catch (error) {
      // A network error can be this machine rather than the service, so it is retried
      // before anyone is told, and the distinction is kept in the message.
      last = { ok: false, problem: `could not reach the service: ${error.message}` };
    }
    if (last.ok) break;
    if (attempt < RETRIES) await sleep(RETRY_DELAY_MS);
  }

  if (last.ok) {
    console.log(`self-check: healthy (commit ${last.commit})`);
    return;
  }
  await notifyFailure(last.problem);
  // A non zero exit makes this usable as a plain shell check too, for a cron entry or a
  // free monitor pointed at the script rather than at the site.
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { checkOnce, BASE_URL };