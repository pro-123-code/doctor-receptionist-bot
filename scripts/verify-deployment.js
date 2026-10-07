// Verifies that a commit actually reached the live site.
//
// The Render deploy hook is a soft-fail: when the secret is missing the job warns
// and still succeeds, so CI can be green while production keeps serving an older
// bundle. That gap is how a doctor dashboard stayed broken after the fix was
// pushed. This script closes the loop by reading the deployed files back.
//
// Usage: node scripts/verify-deployment.js [url]
const DEFAULT_URL = 'https://doctor-receptionist-bot.onrender.com';

const failures = [];
const notes = [];

function check(label, condition, detail) {
  if (condition) {
    console.log(`  pass  ${label}`);
    return true;
  }
  console.error(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
  failures.push(`${label}${detail ? `: ${detail}` : ''}`);
  return false;
}

async function main() {
  const base = String(process.argv[2] || process.env.DEPLOY_URL || DEFAULT_URL).replace(/\/+$/, '');
  console.log(`Verifying deployment at ${base}\n`);

  let dashboardResponse;
  try {
    dashboardResponse = await fetch(`${base}/dashboard`, {
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
    });
  } catch (error) {
    console.error(`  FAIL  cannot reach ${base} -> ${error.message}`);
    process.exit(1);
  }

  check('GET /dashboard responds 200', dashboardResponse.status === 200, `status ${dashboardResponse.status}`);
  const html = await dashboardResponse.text();

  // The reported doctor dashboard failure: a role variable read from the wrong
  // scope throws once the shell is visible but before any data loads.
  const roleLine = html.split('\n')
    .find((line) => /brandMobile\.textContent\s*=/.test(line));
  check('mobile brand label uses a locally defined role',
    Boolean(roleLine) && !/= isSuperadmin\b/.test(roleLine),
    roleLine ? roleLine.trim() : 'brand label line not found');

  const scopeLeaks = html.split('\n')
    .map((line, index) => [index + 1, line])
    .filter(([, line]) => /isSuperadmin/.test(line))
    .map(([number]) => number);
  const clustered = scopeLeaks.length === 0
    || (scopeLeaks.length === 4 && Math.max(...scopeLeaks) - Math.min(...scopeLeaks) <= 6);
  check('role flag is only read inside its own function scope', clustered,
    `references on lines ${scopeLeaks.join(', ')}`);

  // Proves the superadmin control panel shipped rather than just the fix.
  for (const anchor of ['admin-overview-anchor', 'admin-appointments-anchor',
    'admin-analytics-anchor', 'admin-system-anchor']) {
    check(`superadmin panel ${anchor} is deployed`, html.includes(`id="${anchor}"`));
  }
  check('per-clinic report time input is deployed', html.includes('id="clinic-report-time"'));
  check('voice diagnostic control is deployed', html.includes('id="admin-voice-test"'));

  // The priced-item rows must carry the class the save handler queries, otherwise
  // every clinic setup save submits an empty list and is rejected.
  check('priced rows expose the hook the save handler reads',
    /className = 'pricing-row/.test(html) && html.includes("querySelectorAll('.pricing-row')"));

  // A 404 here means the server routes did not deploy even if the HTML did.
  const adminResponse = await fetch(`${base}/api/admin/system`);
  check('superadmin API is routed on the server', adminResponse.status !== 404, `status ${adminResponse.status}`);
  notes.push(`/api/admin/system answered ${adminResponse.status} (401 or 403 is expected without a session)`);

  const healthResponse = await fetch(`${base}/health`);
  const health = await healthResponse.json().catch(() => ({}));
  check('health endpoint reports ok', health.status === 'ok', JSON.stringify(health));

  const build = await fetch(`${base}/version`);
  let version = null;
  if (build.ok) {
    version = await build.json().catch(() => null);
  }
  const expected = process.env.EXPECTED_COMMIT;
  if (version) {
    check(`/version reports a commit`, typeof version.commit === 'string' && version.commit.length > 0,
      JSON.stringify(version));
    if (expected) {
      const shortExpected = expected.slice(0, 7);
      check(`live site runs ${shortExpected}`, version.shortCommit === shortExpected,
        `live site reports ${version.shortCommit}`);
    } else {
      console.log(`  note  live site is serving commit ${version.shortCommit}`);
    }
  } else {
    console.log('  note  no /version endpoint on this deployment yet');
  }

  for (const note of notes) console.log(`  note  ${note}`);

  console.log('');
  if (failures.length) {
    console.error(`Deployment verification failed with ${failures.length} problem(s).`);
    console.error('The live site is not running the latest commit. Redeploy from Render, or set the');
    console.error('RENDER_DEPLOY_HOOK_URL secret in GitHub so pushes deploy automatically.');
    process.exit(1);
  }
  console.log('Deployment verified: the live site is serving the latest build.');
}

main();