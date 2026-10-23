// Executes the real dashboard script against a stubbed DOM.
//
// The contract check only compiles the inline script, so it cannot see a
// ReferenceError such as reading a variable that is scoped to another function.
// That gap let a doctor login succeed and then fail to render, so the entry
// points are invoked here for both roles and every request is recorded.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeDoctorSettings } = require('../src/dashboard.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
if (!inlineScripts.length) {
  console.error('dashboard-runtime: no inline script found');
  process.exit(1);
}
const script = inlineScripts[inlineScripts.length - 1];

// Supports the selector shapes the dashboard actually uses: a class, a class with
// the :checked pseudo class, and a data-attribute. Without real traversal a saved
// payload can silently come back empty.
function matchesSelector(node, selector) {
  if (selector === '.working-day:checked') return Boolean(node.checked);
  const attribute = /^\[([\w-]+)\]$/.exec(selector);
  if (attribute) {
    const key = attribute[1].replace(/^data-/, '').replace(/-([a-z])/g, (_m, letter) => letter.toUpperCase());
    return Boolean(node.dataset) && node.dataset[key] !== undefined;
  }
  const wanted = selector.replace(/^\./, '');
  return typeof node.className === 'string' && node.className.split(/\s+/).includes(wanted);
}

function descendants(root, selector) {
  const found = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (matchesSelector(child, selector)) found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

function createElement(tag = 'div') {
  const element = {
    tagName: String(tag).toUpperCase(),
    id: '',
    hidden: false,
    value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    title: '',
    type: '',
    placeholder: '',
    href: '',
    disabled: false,
    checked: false,
    required: false,
    maxLength: -1,
    dataset: {},
    style: {},
    options: [],
    children: [],
    handlers: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains: () => false
    },
    append(...nodes) { element.children.push(...nodes); },
    appendChild(node) { element.children.push(node); return node; },
    prepend(...nodes) { element.children.unshift(...nodes); },
    replaceChildren(...nodes) { element.children = nodes; },
    removeChild(node) { element.children = element.children.filter((child) => child !== node); },
    remove() {},
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    hasAttribute() { return false; },
    addEventListener(type, handler) { element.handlers[type] = handler; },
    removeEventListener() {},
    dispatchEvent() {},
    focus() {},
    blur() {},
    click() {},
    scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    querySelector(selector) {
      return descendants(element, selector)[0] || null;
    },
    querySelectorAll(selector) {
      return descendants(element, selector);
    },
    closest() { return null; }
  };
  return element;
}

function createHarness() {
  const registry = new Map();
  const requested = [];
  const bodies = [];
  const errors = [];
  const elements = {
    '#notice': createElement(),
    '#brand': createElement(),
    '#admin-overview-cards': createElement(),
    '#admin-appointments': createElement(),
    '#admin-system-body': createElement(),
    '#admin-logs': createElement(),
    '#facility-pricing': createElement(),
    // The appointments table. The harness never stubbed this endpoint, so this view
    // was the one part of the dashboard never actually executed: the day formatter
    // threw before the first row was drawn and the table stayed permanently empty,
    // with search, reschedule, cancel and export all unreachable behind it.
    '#appointments': createElement('tbody'),
    '#empty-state': createElement(),
    '#result-count': createElement(),
    '#stat-today': createElement(),
    '#stat-today-label': createElement()
  };
  const document = {
    title: '',
    body: createElement('body'),
    documentElement: createElement('html'),
    querySelector(selector) {
      if (!registry.has(selector)) registry.set(selector, elements[selector] || createElement());
      return registry.get(selector);
    },
    querySelectorAll(selector) {
      if (selector === '.working-day:checked') {
        return [1, 2, 3, 4, 5].map((day) => Object.assign(createElement('input'), { value: String(day), checked: true }));
      }
      return [];
    },
    getElementById: (id) => document.querySelector(`#${id}`),
    createElement,
    createElementNS: (_namespace, tag) => createElement(tag),
    createDocumentFragment: () => createElement('fragment'),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    removeEventListener() {}
  };
  const responses = {
    // The script probes the session on load; an unauthenticated probe must simply
    // return so the test drives showDashboard itself.
    '/api/dashboard/session': { authenticated: false },
    // Mutated to the stored report time when the form saves, mirroring a server
    // that echoes back what it wrote.
    '/api/dashboard/settings': {
      doctorName: 'Dr. Haider', clinicName: 'Apna city clinic', email: 'haider@example.test',
      religion: 'Muslim', basicCheckupFee: 500, consultationDetails: 'Consultation charges Rs. 1500',
      facilitiesList: ['Clinical pathology', 'Hemoglobin', 'Investigation'], servicesList: [],
      facilityPricing: [
        { category: 'facility', name: 'Clinical pathology', price: 700 },
        { category: 'facility', name: 'Hemoglobin', price: 700 },
        { category: 'facility', name: 'Investigation', price: 700 }
      ],
      workingDays: [1, 2, 3, 4, 5], offDays: [],
      religiousHolidayOpenDays: [], religiousHolidays: [],
      welcomeMessage: 'Assalam-o-Alaikum! Welcome to our clinic', setupComplete: false,
      appointmentLookaheadDays: 14, reportTime: '07:30'
    },
    // A real appointment list, with the shape the server actually sends.
    '/api/dashboard/appointments': {
      date: '2026-10-07', from: '2026-10-07', to: '2026-10-07', grouped: false,
      search: '', timeZone: 'Asia/Karachi',
      appointments: [
        {
          id: 'apt-1', patientName: 'Ada', whatsAppNumber: '+923001234567',
          symptoms: 'Fever and cough', slotStart: '2026-10-08T05:00:00.000Z',
          slotEnd: '2026-10-08T05:15:00.000Z', bookedAt: '2026-10-07T05:00:00.000Z',
          status: 'booked'
        },
        {
          id: 'apt-2', patientName: 'Bilal', whatsAppNumber: '+923009876543',
          symptoms: 'Follow up', slotStart: '2026-10-08T06:00:00.000Z',
          slotEnd: '2026-10-08T06:15:00.000Z', bookedAt: '2026-10-07T06:00:00.000Z',
          status: 'booked'
        }
      ]
    },
    '/api/dashboard/whatsapp/status': {
      status: 'connected', qrDataUrl: null, sessionPersistent: true, sessionNotice: null
    },
    '/api/dashboard/contact': {
      email: 'support@doctorbot.example'
    },
    '/api/dashboard/calendar/status': {
      connected: true, verified: true, calendarId: 'primary', calendarIdEditable: false,
      verificationCode: null, verificationMessage: null, oauthAvailable: true,
      oauthError: null, redirectUri: 'https://example.test/api/auth/google/callback'
    },
    '/api/admin/overview': {
      generatedAt: '2026-10-07T00:00:00.000Z',
      timeZone: 'Asia/Karachi',
      doctors: { total: 2, active: 1, setupPending: 1 },
      appointments: { total: 3, upcoming: 1, today: 1, last30Days: 3, uniquePatients: 2 },
      messaging: { receivedLast24Hours: 4 },
      operations: { errorsLast30Days: 0, warningsLast30Days: 0, failedDailyReports: 0, reportFailuresByDoctor: {} }
    },
    '/api/admin/doctors': {
      doctors: [{
        doctorId: 'clinic-one', doctorName: 'Dr. Haider', clinicName: 'Apna city clinic',
        email: 'haider@example.test', isActive: true, setupComplete: true,
        googleCalendarConnected: false, reportTime: '07:30',
        totalAppointments: 3, upcomingAppointments: 1
      }]
    },
    '/api/admin/appointments': {
      total: 1, limit: 100, timeZone: 'Asia/Karachi',
      appointments: [{
        id: 'a1', doctorId: 'clinic-one', doctorName: 'Dr. Haider', clinicName: 'Apna city clinic',
        patientName: 'Ada', whatsAppNumber: '+92300', symptoms: 'Checkup',
        slotStart: '2026-10-08T05:00:00.000Z', slotEnd: '2026-10-08T05:30:00.000Z',
        bookedAt: '2026-10-07T05:00:00.000Z', status: 'booked'
      }]
    },
    '/api/admin/analytics': {
      generatedAt: '2026-10-07T00:00:00.000Z', days: 14, since: '2026-09-23T00:00:00.000Z',
      timeZone: 'Asia/Karachi',
      dailyBookings: [{ date: '2026-10-07', appointments: 3 }],
      doctors: [{
        doctorId: 'clinic-one', doctorName: 'Dr. Haider', clinicName: 'Apna city clinic',
        email: 'haider@example.test', isActive: true, setupComplete: true, googleCalendarConnected: false,
        totalAppointments: 3, upcomingAppointments: 1, periodAppointments: 3,
        lastBookedAt: '2026-10-07T05:00:00.000Z', messagesReceived: 4, voiceMessages: 0, errors: 0, warnings: 0
      }]
    },
    '/api/admin/system': {
      runtime: {
        nodeVersion: 'v20.20.2', platform: 'linux', uptimeSeconds: 120,
        memoryRoundedMb: 167, heapUsedMb: 80, timeZone: 'Asia/Karachi'
      },
      configuration: {
        nodeEnv: 'production', port: 10000, trustProxy: true, databaseConnected: true,
        databaseHost: 'cluster0.example.mongodb.net', geminiConfigured: true, geminiPatientDataAllowed: false,
        voiceTranscriptionEnabled: false, googleClientConfigured: true,
        googleRedirectUri: 'https://example.test/api/auth/google/callback', googleRedirectUriValid: true,
        smtpConfigured: false, emailFromConfigured: false
      },
      readiness: { features: {}, blocked: [], ready: true },
      whatsapp: { authDirectory: '/data/sessions', sessionPersistent: true, sessionNotice: null, connections: [] },
      clinics: [{ doctorId: 'clinic-one', isActive: true, setupComplete: true, googleCalendarConnected: false }]
    },
    '/api/admin/service-logs': {
      timeZone: 'Asia/Karachi',
      logs: [{ id: 'l1', doctorId: 'clinic-one', doctorName: 'Dr. Haider', level: 'info', event: 'Startup', code: null, createdAt: '2026-10-07T00:00:00.000Z' }]
    }
  };
  let parsedReportTime;
  const fetchStub = async (url, options = {}) => {
    const path_ = String(url).split('?')[0];
    requested.push(path_);
    parsedReportTime = undefined;
    if (options.body) {
      try {
        const parsed = JSON.parse(options.body);
        bodies.push({ path: path_, method: options.method, payload: parsed });
        if (parsed.reportTime) parsedReportTime = parsed.reportTime;
      } catch {
        bodies.push({ path: path_, method: options.method, payload: null });
      }
    }
    if (responses[path_] === undefined) {
      errors.push(`unexpected request ${path_}`);
      return { ok: false, status: 404, json: async () => ({ error: 'not stubbed' }) };
    }
    // A save returns the record as stored, so the dashboard's verification of the
    // report time reads back what was actually written.
    if (options.method === 'PUT' && parsedReportTime) {
      responses[path_] = { ...responses[path_], reportTime: parsedReportTime };
    }
    return { ok: true, status: 200, json: async () => responses[path_] };
  };

  class OptionStub {
    constructor(text, value) { this.text = text; this.value = value === undefined ? text : value; }
  }

  const sandbox = {
    document,
    fetch: fetchStub,
    Option: OptionStub,
    Intl,
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    navigator: {},
    prompt: () => null,
    location: { href: 'https://example.test/dashboard', search: '' },
    URLSearchParams,
    Promise
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  return { context, requested, errors, responses, bodies, document };
}

// Calling a function with no arguments exercises its body far enough to resolve
// every identifier it reads. A wrong stub may cause a TypeError, which is expected
// and ignored, but a ReferenceError means the code reads a variable that only
// exists in another scope, which would break the page for a real user.
async function sweepForScopeErrors() {
  const harness = createHarness();
  vm.runInContext(script, harness.context, { filename: 'dashboard-inline.js' });
  const referenceErrors = [];
  let swept = 0;
  for (const name of Object.keys(harness.context)) {
    if (typeof harness.context[name] !== 'function') continue;
    if (['fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'].includes(name)) continue;
    swept += 1;
    try {
      await harness.context[name]();
    } catch (error) {
      if (error && error.name === 'ReferenceError') referenceErrors.push(`${name} -> ${error.message}`);
    }
  }
  return { referenceErrors, swept };
}

async function renderAs(session) {
  const harness = createHarness();
  const failure = { message: null };
  try {
    vm.runInContext(script, harness.context, { filename: 'dashboard-inline.js' });
    harness.context.showDashboard(session);
  } catch (error) {
    failure.message = error.message;
  }
  // Let the settings promise chain settle so a later rejection is reported too.
  for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  return { ...harness, failure };
}

async function submitForm(session, mutateRows) {
  const harness = await renderAs(session);
  if (harness.failure.message) return { harness, error: harness.failure.message };
  if (typeof mutateRows === 'function') mutateRows(harness.document);
  const form = harness.document.querySelector('#doctor-settings-form');
  if (typeof form.handlers.submit !== 'function') return { harness, error: 'the form has no submit handler' };
  await form.handlers.submit({ preventDefault() {} });
  for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const notice = harness.document.querySelector('#notice');
  return {
    harness,
    message: notice.textContent,
    save: harness.bodies.find((body) => body.method === 'PUT'),
    notice
  };
}

function rowByName(document, name) {
  const rows = document.querySelector('#facility-pricing-list').children;
  return rows.find((row) => row.querySelector('[data-pricing-name]').value === name);
}

async function main() {
  const failures = [];
  const doctorSession = {
    role: 'DOCTOR', doctorId: 'clinic-one', doctorName: 'Dr. Haider', clinicName: 'Apna city clinic'
  };

  // Regression: the priced-item rows were rendered without the class the save
  // handler queries, so every clinic setup save submitted an empty list and the
  // server rejected it with "add at least one facility or treatment" even though
  // rows were visible on screen.
  const submit = await renderAs(doctorSession);
  if (submit.failure.message) failures.push(`doctor session failed to render -> ${submit.failure.message}`);
  const pricingRows = submit.document.querySelector('#facility-pricing-list').children;
  if (pricingRows.length !== 3) {
    failures.push(`expected 3 priced rows to render, found ${pricingRows.length}`);
  }
  const form = submit.document.querySelector('#doctor-settings-form');
  if (typeof form.handlers.submit !== 'function') {
    failures.push('the clinic setup form has no submit handler');
  } else {
    await form.handlers.submit({ preventDefault() {} });
    for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const save = submit.bodies.find((body) => body.method === 'PUT');
    if (!save) {
      failures.push('submitting the clinic setup form never sent a save request');
    } else {
      const pricing = save.payload?.facilityPricing;
      if (!Array.isArray(pricing) || pricing.length !== 3) {
        failures.push(`save sent ${Array.isArray(pricing) ? pricing.length : 'no'} priced items, expected 3 `
          + '-> the form would be rejected as having nothing to save');
      } else {
        const names = pricing.map((item) => item.name);
        for (const expectedName of ['Clinical pathology', 'Hemoglobin', 'Investigation']) {
          if (!names.includes(expectedName)) failures.push(`save dropped the priced item ${expectedName}`);
        }
        if (pricing.some((item) => item.price !== 700 || item.category !== 'facility')) {
          failures.push(`save sent wrong prices or categories -> ${JSON.stringify(pricing)}`);
        }
      }
      if (save.payload?.reportTime !== '07:30') {
        failures.push(`save lost the daily report time -> ${save.payload?.reportTime}`);
      }
      // The form must send the report time and the server must echo it back, so a
      // value dropped before the database write cannot pass silently.
      const savedSettings = submit.responses['/api/dashboard/settings'];
      if (savedSettings.reportTime !== save.payload?.reportTime) {
        failures.push(`the saved report time does not match what was sent -> `
          + `${savedSettings.reportTime} vs ${save.payload?.reportTime}`);
      }
      // A save that reached the server must not also leave an error banner. The
      // handler catches its own errors, so a broken success path shows up here as
      // a ReferenceError message rather than as a failed test.
      const submitNotice = submit.document.querySelector('#notice');
      if (submitNotice.textContent) {
        failures.push(`a successful clinic setup save raised an error banner -> ${submitNotice.textContent}`);
      }
      // The captured payload is the one the browser would really send, so running
      // it through the server validator proves the two halves agree. A mismatch
      // here is exactly what makes a form with visible items fail to save.
      const verdict = normalizeDoctorSettings(save.payload);
      if (verdict.error) {
        failures.push(`the server rejects the payload the form sends -> ${verdict.error}`);
      } else if (verdict.settings?.facilityPricing?.length !== 3) {
        failures.push(`server kept ${verdict.settings?.facilityPricing?.length} priced items instead of 3`);
      } else if (verdict.settings.setupComplete !== true) {
        failures.push('the server did not mark the clinic setup complete');
      }
    }
  }

  // The reported symptom: three saved items on screen, yet the form refused to
  // save. A blank price on one of them used to be reported as "add at least one
  // facility or treatment", which is not what was wrong.
  const blankPrice = await submitForm(doctorSession, (document) => {
    rowByName(document, 'Hemoglobin').querySelector('[data-pricing-price]').value = '';
  });
  if (blankPrice.error) {
    failures.push(`blank price run failed -> ${blankPrice.error}`);
  } else {
    if (blankPrice.save) failures.push('a blank price was still sent to the server instead of being caught first');
    if (!/Enter a price in rupees for "Hemoglobin"/.test(blankPrice.message || '')) {
      failures.push(`blank price reported as "${blankPrice.message}" instead of naming the item`);
    }
    if (/Add at least one/.test(blankPrice.message || '')) {
      failures.push('a blank price is still reported as a missing item');
    }
  }

  const duplicate = await submitForm(doctorSession, (document) => {
    rowByName(document, 'Investigation').querySelector('[data-pricing-name]').value = 'hemoglobin';
  });
  if (duplicate.error) {
    failures.push(`duplicate run failed -> ${duplicate.error}`);
  } else {
    if (duplicate.save) failures.push('a duplicate name was still sent to the server instead of being caught first');
    if (!/listed more than once/.test(duplicate.message || '')) {
      failures.push(`duplicate reported as "${duplicate.message}" instead of naming the duplicate`);
    }
  }

  const blankName = await submitForm(doctorSession, (document) => {
    rowByName(document, 'Hemoglobin').querySelector('[data-pricing-name]').value = '  ';
  });
  if (!blankName.error && blankName.save) {
    failures.push('an empty name was still sent to the server instead of being caught first');
  }
  if (!blankName.error && !/needs a name/.test(blankName.message || '')) {
    failures.push(`empty name reported as "${blankName.message}"`);
  }

  const doctor = await renderAs(doctorSession);
  if (doctor.failure.message) {
    failures.push(`doctor session failed to render -> ${doctor.failure.message}`);
  }
  if (!doctor.requested.includes('/api/dashboard/settings')) {
    failures.push('doctor session never loaded its clinic settings');
  }

  // The reported symptom: the appointments table stayed empty while a red banner read
  // "Invalid option : option". The cause was a day formatter asking for a weekday and
  // a date style together, which the runtime rejects, raised before the first row was
  // drawn. Every action a doctor has lives inside these rows, so an empty table means
  // a doctor cannot search, reschedule or cancel anyone.
  const appointmentView = await renderAs(doctorSession);
  // Driven directly rather than through login: loading it that way is gated behind a
  // completed clinic setup, and the stub is deliberately an incomplete clinic so the
  // setup form path can be tested. The table itself must work for a clinic that has
  // finished setup, which is every real one.
  await appointmentView.context.loadAppointments().catch((error) => {
    failures.push(`loading appointments threw -> ${error.message}`);
  });
  const table = appointmentView.document.querySelector('#appointments');
  const renderedRows = table.children.filter((row) => row.children.some((cell) => cell.textContent));
  if (renderedRows.length === 0) {
    failures.push('the appointments table rendered no rows, so no patient is reachable '
      + `-> banner said "${appointmentView.document.querySelector('#notice').textContent}"`);
  } else {
    if (renderedRows.length !== 2) {
      failures.push(`expected 2 appointment rows, rendered ${renderedRows.length}`);
    }
    const first = renderedRows[0];
    const cellText = first.children.map((cell) => cell.textContent);
    if (!cellText.some((text) => text.includes('Ada'))) {
      failures.push(`the first appointment row does not name the patient -> ${JSON.stringify(cellText)}`);
    }
    if (!cellText.some((text) => /\+923001234567/.test(text))) {
      failures.push('the row does not show the WhatsApp number');
    }
    if (!cellText.some((text) => text.includes('Fever and cough'))) {
      failures.push('the row does not show the symptoms');
    }
    // The time is what proves a formatter actually ran rather than being skipped.
    if (!cellText.some((text) => /\d{1,2}:\d{2}/.test(text))) {
      failures.push(`the row shows no appointment time -> ${JSON.stringify(cellText)}`);
    }
    // Reschedule and cancel hang off the row, so an empty table hides both.
    const actionLabels = first.children
      .flatMap((cell) => cell.children)
      .filter((child) => child.tagName === 'BUTTON')
      .map((button) => button.textContent);
    if (!actionLabels.includes('Reschedule')) {
      failures.push(`the row offers no reschedule action -> ${JSON.stringify(actionLabels)}`);
    }
    if (!actionLabels.includes('Cancel')) {
      failures.push(`the row offers no cancel action -> ${JSON.stringify(actionLabels)}`);
    }
    // And the banner must not be carrying an error the doctor cannot act on.
    const viewNotice = appointmentView.document.querySelector('#notice');
    if (viewNotice.textContent) {
      failures.push(`loading appointments raised an error banner -> ${viewNotice.textContent}`);
    }
  }
  if (doctor.requested.some((url) => url.startsWith('/api/admin/'))) {
    failures.push(`doctor session requested an admin endpoint -> ${doctor.requested.filter((url) => url.startsWith('/api/admin/')).join(', ')}`);
  }
  for (const message of doctor.errors) failures.push(`doctor session: ${message}`);

  // The superadmin control panel mapped over the result of loadDoctors, which
  // returned nothing. That threw "Cannot read properties of undefined (reading
  // 'map')" and aborted the remaining panel loads, so the red banner appeared and
  // appointments, analytics and system status never rendered.
  const adminSession = { role: 'SUPERADMIN', doctorId: null, doctorName: null, clinicName: null };
  const adminLoad = await renderAs(adminSession);
  if (adminLoad.failure.message) {
    failures.push(`superadmin panel failed to render -> ${adminLoad.failure.message}`);
  }
  const adminNotice = adminLoad.document.querySelector('#notice');
  if (adminNotice.textContent) {
    failures.push(`superadmin panel raised an error banner -> ${adminNotice.textContent}`);
  }
  for (const panel of ['#admin-overview-cards', '#admin-appointments', '#admin-analytics', '#admin-system-body']) {
    const container = adminLoad.document.querySelector(panel);
    if (container && container.children.length === 0) {
      failures.push(`superadmin panel ${panel} rendered nothing after load`);
    }
  }
  if (!adminLoad.requested.some((url) => url === '/api/admin/appointments')) {
    failures.push('the superadmin appointments panel was never requested');
  }
  if (!adminLoad.requested.some((url) => url === '/api/admin/analytics')) {
    failures.push('the superadmin analytics panel was never requested');
  }
  // The clinic id has to land in its own column, because a half created account
  // still shows the default names and the id is the only way to confirm a deletion.
  const doctorTable = adminLoad.document.querySelector('#doctor-accounts');
  const firstRow = doctorTable.children[0];
  const idCell = firstRow && firstRow.children[3];
  const idChip = idCell && idCell.children[0];
  if (!idChip || idChip.textContent !== 'clinic-one') {
    failures.push(`the doctor table does not show the clinic id in its own column -> ${idChip && idChip.textContent}`);
  }
  // Chip rendering after the inserted column reads fixed indexes.
  const setupCell = firstRow && firstRow.children[6];
  if (!setupCell || !setupCell.children[0] || setupCell.children[0].textContent !== 'Complete') {
    failures.push('the setup chip is in the wrong column after adding the clinic id column');
  }

  const admin2 = await renderAs(adminSession);
  const admin = admin2;
  if (admin.failure.message) {
    failures.push(`superadmin session failed to render -> ${admin.failure.message}`);
  }
  if (!admin.requested.some((url) => url.startsWith('/api/admin/'))) {
    failures.push('superadmin session never loaded the control panel');
  }

  // A session with no role must never be treated as superadmin.
  const roleless = await renderAs({ doctorName: 'Dr. Haider', clinicName: 'Apna city clinic' });
  if (roleless.failure.message) {
    failures.push(`session without a role failed to render -> ${roleless.failure.message}`);
  }
  if (roleless.requested.some((url) => url.startsWith('/api/admin/'))) {
    failures.push('a session without a role requested an admin endpoint');
  }

  // The superadmin edit path runs the same submit handler, so a broken success
  // path there would also raise an error banner rather than failing loudly.
  const adminSave = await renderAs(adminSession);
  if (!adminSave.failure.message) {
    const clinicName = adminSave.document.querySelector('#profile-clinic-name');
    if (clinicName) clinicName.value = 'Renamed Clinic';
    const adminForm = adminSave.document.querySelector('#doctor-settings-form');
    if (typeof adminForm.handlers.submit === 'function') {
      await adminForm.handlers.submit({ preventDefault() {} });
      for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      const adminNotice = adminSave.document.querySelector('#notice');
      if (adminNotice.textContent) {
        failures.push(`a superadmin clinic save raised an error banner -> ${adminNotice.textContent}`);
      }
    }
  }

  const sweep = await sweepForScopeErrors();
  for (const message of sweep.referenceErrors) {
    failures.push(`scope error -> ${message}`);
  }
  if (sweep.swept < 20) {
    failures.push(`only ${sweep.swept} functions were swept, so the scope check is not meaningful`);
  }

  if (failures.length) {
    for (const message of failures) console.error(`dashboard-runtime: ${message}`);
    process.exit(1);
  }

  console.log(`dashboard-runtime: clinic setup save payload verified, `
    + `appointments rendered with patient, time and reschedule and cancel actions, `
    + `doctor, superadmin and role-less sessions rendered, `
    + `${sweep.swept} functions swept for scope errors`);
}

main();