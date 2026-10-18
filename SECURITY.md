# Security Policy

## Reporting a vulnerability

Email the maintainer directly. Please do not open a public issue for anything that
could expose patient data or let someone into a clinic's dashboard.

Useful to include: what an attacker can do, which endpoint or clinic is affected, and
how to reproduce it. A proof of concept is welcome and preferred over a description.

We aim to acknowledge within 2 working days.

## What this system holds

Patient names, WhatsApp numbers, appointment times, and the symptoms patients describe.
Symptoms can be sensitive health information, so treat them as such.

That is why the AI provider is not sent patient text unless a clinic explicitly opts in
with `GEMINI_ALLOW_PHI_PROCESSING=true`. It is off by default, and the readiness panel
shows the current state so nobody has to guess.

## Tenant isolation

Each clinic is a separate tenant. Every query and write is scoped by clinic, and patient
actions are additionally scoped to the sending WhatsApp number, so one clinic can never
read or move another's bookings. There are tests asserting this, including that removing
the sender scope fails the suite.

## Secrets

- Every secret lives in the Render environment or a CI secret. Nothing secret is
  committed. `.env.example` contains placeholders only.
- Google OAuth refresh tokens are encrypted at rest with `SECRET_ENCRYPTION_KEY`.
  Losing that key makes stored tokens unreadable and every calendar must be reconnected.
- Never paste a live credential into a chat, a ticket or an issue. If one has been
  exposed, rotate it first, then investigate. A credential in a chat transcript is
  compromised even if the channel is private.

## WhatsApp

Session handling uses an unofficial WhatsApp client. This works and costs nothing, but
it is not endorsed by WhatsApp and using it carries a risk of the sending number being
restricted. That matters most for a clinic whose number is its public contact. Prefer a
number used only for this, never the clinic's primary line.

## Out of scope

- Denial of service against the hosted instance
- Findings that require an already-compromised host
- Missing hardening headers with no demonstrated impact