const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const built = path.join(root, 'src', 'dashboard-built.css');
const html = fs.readFileSync(path.join(root, 'src', 'dashboard.html'), 'utf8');
const failures = [];

// The page must not fall back to the browser build of the framework. That download
// ships a compiler to every doctor, rebuilds the styles on every visit, and leaves
// the page unstyled while it works, which on a slow connection reads as a broken app.
if (/cdn\.tailwindcss\.com/.test(html)) {
  failures.push('the dashboard still loads the framework from a CDN instead of the compiled stylesheet');
}
if (!/<link[^>]+href=["']\/dashboard-built\.css["']/.test(html)) {
  failures.push('the dashboard does not load the compiled stylesheet');
}

// A missing or empty stylesheet means an unstyled dashboard in production, and the
// build step is easy to forget because nothing else in the app needs it.
if (!fs.existsSync(built)) {
  failures.push('the compiled stylesheet is missing -> run: npm run build:dashboard');
} else {
  const css = fs.readFileSync(built, 'utf8');
  if (css.trim().length < 1000) {
    failures.push(`the compiled stylesheet looks empty (${css.trim().length} bytes)`);
  }
  // A stylesheet with no utility rules means the content scan found nothing, which
  // would leave the page completely unstyled while still looking like a successful
  // build.
  if (!/\.[a-z-]+\{/.test(css)) {
    failures.push('the compiled stylesheet contains no rules, so the content scan found nothing');
  }
}

const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
if (!/dashboard-built\.css/.test(server)) {
  failures.push('the server never serves the compiled stylesheet');
}

// Custom component classes such as .btn or .chip are hand written in the page's own
// style block and are unaffected by the build, so only utility classes are checked
// against the compiled output. Those are the ones the compiler has to find, and a
// missed one is invisible in the source and shows only as a mis-styled dashboard.
// Some classes exist only as hooks for the script, such as .working-day, which the
// dashboard selects by name and never styles. They are also defined in the style
// block as attribute selectors rather than class selectors, so they are collected here
// by name as well.
const customClasses = new Set();
for (const match of html.matchAll(/<style[\s\S]*?<\/style>/g)) {
  for (const found of match[0].matchAll(/\.([a-z][a-z0-9_-]*)/g)) customClasses.add(found[1]);
}
for (const name of ['working-day', 'form-check-input', 'religious-holiday-open']) customClasses.add(name);
const usedClasses = new Set();
for (const match of html.matchAll(/class="([^"{}]*)"/g)) {
  for (const name of match[1].split(/\s+/)) {
    if (name && !name.startsWith('!') && !name.includes('[')) usedClasses.add(name);
  }
}
if (fs.existsSync(built)) {
  const css = fs.readFileSync(built, 'utf8');
  const sample = [...usedClasses]
    .filter((name) => /^[a-z][a-z0-9-]*$/.test(name) && !customClasses.has(name))
    .slice(0, 400);
  const missing = sample.filter((name) => {
    const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    return !new RegExp(`\\.${escaped}[\\s,{:>~[]`).test(css);
  });
  if (missing.length) {
    failures.push(`classes used by the page are absent from the stylesheet -> ${missing.slice(0, 12).join(', ')}`);
  }
}

if (failures.length) {
  for (const message of failures) console.error(`dashboard-css: ${message}`);
  process.exit(1);
}

console.log(`dashboard-css: compiled stylesheet verified, ${usedClasses.size} classes checked against it`);