// Guards the dashboard redesign: every element the client script and the server
// depend on must still exist, and the script must stay free of syntax errors.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');

const requiredIds = [
  'add-facility-pricing', 'add-off-day', 'admin-dashboard', 'admin-refresh', 'appointment-duration',
  'appointment-lookahead', 'appointments', 'basic-checkup-fee', 'brand', 'calendar-connection-status',
  'calendar-oauth-setup', 'calendar-panel', 'calendar-redirect-uri', 'calendar-setup-steps',
  'calendar-test-result', 'cancel-clinic-setup', 'clinic-experience', 'clinic-setup-eyebrow',
  'clinic-setup-panel', 'connect-calendar', 'connect-whatsapp', 'create-doctor-form', 'date-form',
  'disconnect-calendar', 'doctor-accounts', 'doctor-dashboard', 'doctor-settings-form',
  'edit-clinic-setup', 'email', 'empty-state', 'facility-pricing-list', 'google-calendar-id',
  'login', 'login-form', 'logout', 'notice', 'off-day-date', 'off-day-list', 'office-end-hour',
  'office-start-hour', 'password', 'profile-clinic-name', 'profile-consultation-details',
  'profile-doctor-name', 'profile-email', 'profile-email-field', 'profile-religion',
  'profile-welcome', 'refresh', 'religious-holiday-list', 'report-date', 'result-count',
  'save-calendar-id', 'setup-title', 'test-calendar', 'timing-error', 'timing-summary',
  'whatsapp-connection-status', 'whatsapp-qr', 'whatsapp-qr-panel', 'whatsapp-session-notice'
];

const missing = requiredIds.filter((id) => !html.includes(`id="${id}"`));
if (missing.length) {
  console.error('dashboard: missing required elements ->', missing.join(', '));
  process.exit(1);
}

// Duplicate ids silently break getElementById/querySelector wiring.
const idCounts = new Map();
for (const match of html.matchAll(/\sid="([^"]+)"/g)) {
  idCounts.set(match[1], (idCounts.get(match[1]) || 0) + 1);
}
const duplicates = [...idCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
if (duplicates.length) {
  console.error('dashboard: duplicate ids ->', duplicates.join(', '));
  process.exit(1);
}

// Every id the markup declares should be unique and free of whitespace.
for (const id of idCounts.keys()) {
  if (/\s/.test(id)) {
    console.error(`dashboard: invalid id "${id}"`);
    process.exit(1);
  }
}

for (let weekday = 0; weekday <= 6; weekday += 1) {
  if (!html.includes(`class="form-check-input working-day" type="checkbox" value="${weekday}"`)
    && !new RegExp(`working-day[^>]*value="${weekday}"`).test(html)) {
    console.error(`dashboard: missing working-day checkbox ${weekday}`);
    process.exit(1);
  }
}

// Any selector the script queries must resolve to an element that really exists.
const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const inline = scriptMatches.map((match) => match[1]).find((code) => code.includes('doctor-settings-form'));
if (!inline) {
  console.error('dashboard: inline script not found');
  process.exit(1);
}
try {
  new vm.Script(inline, { filename: 'dashboard-inline.js' });
} catch (error) {
  console.error('dashboard: inline script syntax error ->', error.message);
  process.exit(1);
}

const referenced = [...new Set([...inline.matchAll(/querySelector\('#([a-zA-Z0-9-]+)'\)/g)].map((m) => m[1]))];
const dangling = referenced.filter((id) => !html.includes(`id="${id}"`));
if (dangling.length) {
  console.error('dashboard: script queries elements that do not exist ->', dangling.join(', '));
  process.exit(1);
}

for (const endpoint of ['/api/dashboard/login', '/api/dashboard/logout', '/api/dashboard/session',
  '/api/dashboard/appointments', '/api/dashboard/settings', '/api/dashboard/whatsapp/status',
  '/api/dashboard/whatsapp/connect', '/api/dashboard/calendar/status', '/api/dashboard/calendar/settings',
  '/api/dashboard/calendar/disconnect', '/api/admin/doctors',
  '/api/admin/overview', '/api/admin/appointments', '/api/admin/analytics', '/api/admin/system',
  '/api/admin/service-logs']) {
  if (!inline.includes(endpoint)) {
    console.error(`dashboard: script no longer calls ${endpoint}`);
    process.exit(1);
  }
}

// Every admin panel and route must be real: implemented on the server, behind the
// superadmin guard, and reachable from the sidebar.
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
for (const match of serverSource.matchAll(/app\.(get|post|put|patch)\('(\/api\/admin\/[^']*)',\s*([^)]*)\)/g)) {
  const [, , route, guards] = match;
  if (!/requireDashboardAuth/.test(guards) || !/requireSuperadmin/.test(guards)) {
    console.error(`server: ${route} is missing superadmin authorization`);
    process.exit(1);
  }
}
const adminRoutes = [...serverSource.matchAll(/app\.(get|post|put|patch)\('\/api\/admin\//g)].length;
if (adminRoutes < 8) {
  console.error(`server: expected a full control panel, found only ${adminRoutes} admin routes`);
  process.exit(1);
}
for (const anchor of ['admin-overview-anchor', 'admin-appointments-anchor', 'admin-analytics-anchor',
  'admin-system-anchor', 'admin-doctors-anchor', 'admin-create-anchor']) {
  if (!html.includes(`id="${anchor}"`)) {
    console.error(`dashboard: admin panel ${anchor} is missing`);
    process.exit(1);
  }
}

// Every sidebar link must target an anchor that exists and must have a click
// handler, otherwise the menu silently does nothing.
const navLinks = [...html.matchAll(/<a[^>]*href="#([a-zA-Z0-9-]+)"[^>]*>/g)].map((match) => match[1]);
for (const target of navLinks) {
  if (!html.includes(`id="${target}"`)) {
    console.error(`dashboard: nav link points at missing anchor #${target}`);
    process.exit(1);
  }
}
const navIds = [...html.matchAll(/<a[^>]*id="([a-z0-9-]+)"[^>]*href="#/g)].map((match) => match[1]);
for (const id of navIds) {
  const variable = id.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
  const declared = new RegExp(`const ${variable} = document\\.querySelector\\('#${id}'\\)`).test(inline);
  const handled = new RegExp(`${variable}\\.addEventListener\\('click'`).test(inline);
  if (!declared || !handled) {
    console.error(`dashboard: nav link #${id} is not wired up (declared=${declared}, clickHandler=${handled})`);
    process.exit(1);
  }
}

// Role-dependent navigation must be recomputed, not left at its markup default.
if (!/function updateNavVisibility\(\)/.test(inline)) {
  console.error('dashboard: role-aware navigation helper is missing');
  process.exit(1);
}
if (!/navAppointments\.hidden = isSuperadmin/.test(inline)) {
  console.error('dashboard: superadmin still sees doctor-only navigation');
  process.exit(1);
}

console.log(`dashboard: ${requiredIds.length} elements, ${referenced.length} selectors, `
  + `${navLinks.length} nav anchors, ${navIds.length} nav handlers, `
  + `${adminRoutes} guarded admin routes and all endpoints verified`);