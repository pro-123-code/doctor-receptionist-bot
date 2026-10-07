// Executes the real dashboard script against a stubbed DOM.
//
// The contract check only compiles the inline script, so it cannot see a
// ReferenceError such as reading a variable that is scoped to another function.
// That gap let a doctor login succeed and then fail to render, so the entry
// points are invoked here for both roles and every request is recorded.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
if (!inlineScripts.length) {
  console.error('dashboard-runtime: no inline script found');
  process.exit(1);
}
const script = inlineScripts[inlineScripts.length - 1];

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
    querySelector() { return createElement(); },
    querySelectorAll() { return []; },
    closest() { return null; }
  };
  return element;
}

function createHarness() {
  const registry = new Map();
  const requested = [];
  const errors = [];
  const elements = {
    '#notice': createElement(),
    '#brand': createElement(),
    '#admin-overview-cards': createElement(),
    '#admin-appointments': createElement(),
    '#admin-system-body': createElement(),
    '#admin-logs': createElement(),
    '#facility-pricing': createElement()
  };
  const document = {
    title: '',
    body: createElement('body'),
    documentElement: createElement('html'),
    querySelector(selector) {
      if (!registry.has(selector)) registry.set(selector, elements[selector] || createElement());
      return registry.get(selector);
    },
    querySelectorAll: () => [],
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
    '/api/dashboard/settings': {
      doctorName: 'Dr. Haider', clinicName: 'Apna city clinic', email: 'haider@example.test',
      religion: 'Muslim', basicCheckupFee: 500, consultationDetails: '', facilitiesList: [],
      servicesList: [], facilityPricing: [], workingDays: [1, 2, 3, 4, 5], offDays: [],
      religiousHolidayOpenDays: [], religiousHolidays: [], welcomeMessage: '', setupComplete: false,
      appointmentLookaheadDays: 14, reportTime: '07:30'
    }
  };
  const fetchStub = async (url) => {
    const path_ = String(url).split('?')[0];
    requested.push(path_);
    if (responses[path_] === undefined) {
      errors.push(`unexpected request ${path_}`);
      return { ok: false, status: 404, json: async () => ({ error: 'not stubbed' }) };
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
    location: { href: 'https://example.test/dashboard', search: '' },
    URLSearchParams,
    Promise
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  return { context, requested, errors, responses };
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

async function main() {
  const failures = [];

  const doctor = await renderAs({ role: 'DOCTOR', doctorId: 'clinic-one', doctorName: 'Dr. Haider', clinicName: 'Apna city clinic' });
  if (doctor.failure.message) {
    failures.push(`doctor session failed to render -> ${doctor.failure.message}`);
  }
  if (!doctor.requested.includes('/api/dashboard/settings')) {
    failures.push('doctor session never loaded its clinic settings');
  }
  if (doctor.requested.some((url) => url.startsWith('/api/admin/'))) {
    failures.push(`doctor session requested an admin endpoint -> ${doctor.requested.filter((url) => url.startsWith('/api/admin/')).join(', ')}`);
  }
  for (const message of doctor.errors) failures.push(`doctor session: ${message}`);

  const admin = await renderAs({ role: 'SUPERADMIN', doctorId: null, doctorName: null, clinicName: null });
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

  console.log(`dashboard-runtime: doctor, superadmin and role-less sessions rendered, `
    + `${doctor.requested.length + admin.requested.length + roleless.requested.length} requests verified, `
    + `${sweep.swept} functions swept for scope errors`);
}

main();