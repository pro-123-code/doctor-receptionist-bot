# DoctorBot

A WhatsApp receptionist for private clinics in Pakistan. Patients book, reschedule and
cancel by messaging; the doctor manages the clinic from a web dashboard.

Each clinic is a separate tenant. Every query and every write is scoped to the clinic
and, for patient actions, to the sending number.

## What it does

- **Books appointments** over WhatsApp in Roman Urdu and Roman English, including
  voice notes
- **Reschedules and cancels** at the patient's request
- **Reminds** patients and produces a daily report by email
- **Syncs Google Calendar** in both directions
- **Closes on religious holidays**, fetched automatically and overridable per doctor
- **Dashboard** for clinic setup, pricing, timings, appointments and a superadmin panel

## Requirements

Node 20.19 or newer. The version is pinned in `.nvmrc` because the app, the tests and
the deployed service must agree: a fault once shipped because a feature was built on a
runtime that CI never ran.

```
npm ci
npm run build:dashboard
npm start
```

Copy `.env.example` to `.env` and fill it in. Every variable is described there.

## Verifying a change

```
npm run verify
```

Runs every gate in order: syntax, server boot, dashboard contract, stylesheet build
and check, dashboard rendering, and the test suite. CI runs the same set and refuses to
deploy if any of them fail.

Individual gates:

| Command | What it proves |
|---|---|
| `npm run check` | The server parses |
| `npm run smoke` | The server module loads without connecting |
| `npm run dashboard:check` | The page's elements, selectors and endpoints line up |
| `npm run build:dashboard` | The stylesheet compiles |
| `npm run dashboard:css` | Every class the page uses exists in the stylesheet |
| `npm run dashboard:runtime` | The page actually renders, including real appointment rows |
| `npm test` | The test suite |
| `npm run audit` | Dependency advisories |

`dashboard:runtime` exists because the unit suite passed while the appointments table
had never rendered a single row. The unit tests exercise logic in isolation; that gate
executes the page. A fault that only appears when the real code runs together is
invisible to everything else, and two shipped that way.

## Deploying

Push to `main`. CI runs the gates, then triggers the Render deploy hook and verifies
the live site reports the pushed commit. The deploy step fails rather than passing
quietly if `RENDER_DEPLOY_HOOK_URL` is missing, because a green pipeline that deployed
nothing is worse than a red one.

`render.yaml` pins Node, the health check and the build command so they cannot drift
from the repository.

After deploying, confirm it landed:

```
npm run self:check
EXPECTED_COMMIT=$(git rev-parse HEAD) npm run self:check
```

## Monitoring

**Run `npm run self:check` on a schedule** (Render cron job, or any external scheduler).
It reports only failures, so a quiet run means everything is well. Set
`ALERT_WEBHOOK_URL` to be told directly.

It checks two things: that `/health` reports a healthy database, and that `/version`
reports the commit you expected. The second matters because a service can be perfectly
healthy while running an older build, which looks identical to working until you look.

This runs *inside* the service, so it cannot report that the service itself is gone.
Point a free external monitor at `/health` as well; [UptimeRobot](https://uptimerobot.com)
allows 50 checks a month. The free Render instance also sleeps after inactivity, so a
monitor polling it doubles as the thing that keeps it awake and stops patients waiting
fifty seconds for a reply.

## Testing WhatsApp

Sessions are stored in MongoDB, so a deploy no longer loses them and a QR rescan is not
needed. The dashboard shows the connection state under Connections.

## Security notes

- Patient medical text is never sent to the AI provider unless
  `GEMINI_ALLOW_PHI_PROCESSING` is explicitly set to `true`. It is off by default.
- Google OAuth tokens are encrypted at rest. `SECRET_ENCRYPTION_KEY` must be a stable
  32 byte key; changing it makes existing tokens unreadable.
- Every secret belongs in the Render environment. Nothing secret belongs in git.

See `SECURITY.md` for reporting a vulnerability.